import { query } from "../config/db.js";
import { sendLeaveRequestNotification, sendLeaveStatusEmail } from "../services/emailService.js";
import { sendNotificationOnce } from "../services/notificationService.js";

/**
 * Extracts pure YYYY-MM-DD from string or Date object without timezone shift.
 */
export const formatDateOnly = (val) => {
  if (!val) return "";
  if (typeof val === "string") {
    const match = val.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return "";
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, "0");
    const d = String(val.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(val).substring(0, 10);
};

export const calculateDaysBetween = (startDate, endDate) => {
  const s = formatDateOnly(startDate);
  const e = formatDateOnly(endDate) || s;
  if (!s) return 0;
  if (!e) return 1;
  const [y1, m1, d1] = s.split("-").map(Number);
  const [y2, m2, d2] = e.split("-").map(Number);
  if (!y1 || !y2) return 1;
  const utc1 = Date.UTC(y1, m1 - 1, d1);
  const utc2 = Date.UTC(y2, m2 - 1, d2);
  const diffDays = Math.round((utc2 - utc1) / (1000 * 60 * 60 * 24)) + 1;
  return diffDays > 0 ? diffDays : 0;
};

export const getLeaveRequests = async (req, res) => {
  try {
    const { companyId, userId, status } = req.query;
    const isSuperAdmin = req.user?.role?.toLowerCase() === "superadmin";
    const targetCompanyId = (isSuperAdmin && companyId) ? companyId : req.user?.companyId;

    let sql = `
      SELECT l.*, l.id as "_id", u.name as user_name, u.name as "userName", u.email as user_email, u.department as "userDept", u.department
      FROM leave_requests l
      LEFT JOIN users u ON l.user_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (targetCompanyId) {
      params.push(targetCompanyId);
      sql += ` AND l.company_id = $${params.length}`;
    }

    if (req.user?.role && !["admin", "superadmin", "manager"].includes(req.user.role)) {
      params.push(req.user.id);
      sql += ` AND l.user_id = $${params.length}`;
    } else if (userId) {
      params.push(userId);
      sql += ` AND l.user_id = $${params.length}`;
    }

    if (status) {
      params.push(status);
      sql += ` AND l.status = $${params.length}`;
    }

    sql += " ORDER BY l.applied_at DESC NULLS LAST LIMIT 500";

    const result = await query(sql, params);
    
    // Camelcase and comprehensive mapping for frontend
    const leaves = result.rows.map(row => {
      const totalDays = Number(row.total_days || 1);
      const leaveType = row.leave_type || "Casual Leave";
      const startDateStr = formatDateOnly(row.start_date);
      const endDateStr = formatDateOnly(row.end_date);
      const durationStr = `${totalDays} Day${totalDays > 1 ? "s" : ""}`;

      return {
        ...row,
        id: row.id,
        _id: row.id,
        userId: row.user_id,
        user_id: row.user_id,
        companyId: row.company_id,
        company_id: row.company_id,
        userName: row.userName || row.user_name || "Employee",
        user_name: row.userName || row.user_name || "Employee",
        userEmail: row.user_email || "",
        user_email: row.user_email || "",
        userDept: row.userDept || row.department || "Engineering",
        department: row.department || row.userDept || "Engineering",
        leaveType,
        leave_type: leaveType,
        type: leaveType,
        startDate: startDateStr,
        endDate: endDateStr,
        start_date: startDateStr,
        end_date: endDateStr,
        totalDays,
        total_days: totalDays,
        duration: durationStr,
        reason: row.reason || "",
        status: row.status || "pending",
        appliedAt: row.applied_at || row.created_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        rejectionReason: row.rejection_reason || "",
        rejection_reason: row.rejection_reason || "",
        managerComment: row.rejection_reason || "",
        reviewedBy: row.reviewed_by,
        reviewed_by: row.reviewed_by,
        reviewedAt: row.reviewed_at,
        reviewed_at: row.reviewed_at
      };
    });

    res.json(leaves);
  } catch (err) {
    console.error("getLeaveRequests error:", err);
    res.status(500).json({ error: "Failed to fetch leave requests." });
  }
};

export const createLeaveRequest = async (req, res) => {
  try {
    let { leaveType, startDate, endDate, totalDays, reason } = req.body;
    const userId = req.user?.id || req.body.userId;
    const companyId = req.user?.companyId || req.body.companyId;

    if (leaveType && String(leaveType).match(/^\d{4}-\d{2}-\d{2}/) && startDate && !String(startDate).match(/^\d{4}-\d{2}-\d{2}/)) {
      const temp = startDate;
      startDate = leaveType;
      leaveType = temp;
    }

    if (!leaveType || !startDate || !endDate || !reason) {
      return res.status(400).json({ error: "Missing required leave request fields." });
    }

    const cleanStartDate = formatDateOnly(startDate);
    const cleanEndDate = formatDateOnly(endDate);

    if (cleanEndDate < cleanStartDate) {
      return res.status(400).json({ error: "End Date cannot be before Start Date." });
    }

    // 1. Before calculating leave duration, check the employee's existing leave requests.
    // 2. Check both Pending and Approved leave requests.
    // 3. Detect overlapping dates using: newStartDate <= existingEndDate && newEndDate >= existingStartDate
    const existingRes = await query(
      `SELECT id, leave_type, start_date, end_date, total_days, status
       FROM leave_requests
       WHERE user_id = $1
         AND status IN ('pending', 'approved')`,
      [userId]
    );

    const hasOverlap = existingRes.rows.some(r => {
      const existingStartDate = formatDateOnly(r.start_date);
      const existingEndDate = formatDateOnly(r.end_date) || existingStartDate;
      if (!existingStartDate) return false;
      return cleanStartDate <= existingEndDate && cleanEndDate >= existingStartDate;
    });

    if (hasOverlap) {
      return res.status(400).json({
        error: "You already have a leave request for some of these dates. Please select a different date range."
      });
    }

    // 5. If there is no overlap, calculate duration correctly
    const calculatedDays = calculateDaysBetween(cleanStartDate, cleanEndDate);
    const parsedDays = calculatedDays > 0 ? calculatedDays : Number(parseInt(totalDays) || 1);

    const id = "leave_" + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
    const result = await query(
      `INSERT INTO leave_requests (id, user_id, company_id, leave_type, start_date, end_date, total_days, reason, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
       RETURNING *`,
      [id, userId, companyId, leaveType, cleanStartDate, cleanEndDate, parsedDays, reason]
    );

    const leave = result.rows[0];
    const userRes = await query("SELECT name, email, department FROM users WHERE id = $1", [userId]);
    const user = userRes.rows[0] || {};

    const formattedLeave = {
      ...leave,
      id: leave.id,
      _id: leave.id,
      userId: leave.user_id,
      user_id: leave.user_id,
      companyId: leave.company_id,
      company_id: leave.company_id,
      userName: user.name || "Employee",
      user_name: user.name || "Employee",
      userEmail: user.email || "",
      userDept: user.department || "Engineering",
      department: user.department || "Engineering",
      leaveType: leave.leave_type,
      type: leave.leave_type,
      startDate: cleanStartDate,
      endDate: cleanEndDate,
      start_date: cleanStartDate,
      end_date: cleanEndDate,
      totalDays: parsedDays,
      total_days: parsedDays,
      duration: `${parsedDays} Day${parsedDays > 1 ? "s" : ""}`,
      status: "pending",
      reason: leave.reason,
      appliedAt: leave.applied_at || leave.created_at
    };

    // Asynchronously notify company admin / manager
    (async () => {
      try {
        const employeeName = user.name || "An employee";
        const adminRes = await query(
          "SELECT id, email FROM users WHERE company_id = $1 AND role IN ('admin', 'superadmin', 'manager')",
          [companyId]
        );
        for (const admin of adminRes.rows) {
          sendLeaveRequestNotification({
            adminEmail: admin.email,
            employeeName,
            leaveType,
            startDate: cleanStartDate,
            endDate: cleanEndDate,
            totalDays: parsedDays,
            reason
          }).catch(() => {});

          await sendNotificationOnce(admin.id, {
            title: "New Leave Request",
            message: `${employeeName} requested ${parsedDays} day(s) ${leaveType} (${cleanStartDate} to ${cleanEndDate}).`,
            type: "leave",
            link: "/admin?tab=logs&sub=leaves"
          }).catch(() => {});
        }
      } catch (e) {
        console.error("Error dispatching leave request notification:", e);
      }
    })();

    res.status(201).json(formattedLeave);
  } catch (err) {
    console.error("createLeaveRequest error:", err);
    res.status(500).json({ error: "Failed to create leave request." });
  }
};

export const updateLeaveStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rejectionReason, managerComment } = req.body;
    const reviewerId = req.user?.id || null;
    const callerRole = req.user?.role?.toLowerCase();
    const isManagerOrAdmin = callerRole === "admin" || callerRole === "superadmin" || callerRole === "manager" || callerRole === "system admin";

    if (!["approved", "rejected", "cancelled", "pending"].includes(status)) {
      return res.status(400).json({ error: "Invalid status." });
    }

    // Only managers/admins can approve or reject leaves
    if ((status === "approved" || status === "rejected") && !isManagerOrAdmin) {
      return res.status(403).json({ error: "Access forbidden. Manager or Admin role required to approve/reject leaves." });
    }

    const prevRes = await query("SELECT * FROM leave_requests WHERE id = $1", [id]);
    if (prevRes.rows.length === 0) {
      return res.status(404).json({ error: "Leave request not found." });
    }
    const prevLeave = prevRes.rows[0];
    const prevStatus = prevLeave.status;

    const result = await query(
      `UPDATE leave_requests
       SET status = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP, rejection_reason = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING *`,
      [status, reviewerId, rejectionReason || managerComment || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Leave request not found." });
    }

    const updatedLeave = result.rows[0];
    const totalDays = Number(updatedLeave.total_days || 1);
    const leaveTypeLower = String(updatedLeave.leave_type || "").toLowerCase();

    let quotaColumn = "casual_leave_quota"; // Default: Annual Leave (25 days)
    let defaultQuota = 25;
    if (leaveTypeLower.includes("sick")) {
      quotaColumn = "sick_leave_quota";
      defaultQuota = 10;
    } else if (leaveTypeLower.includes("casual") || leaveTypeLower.includes("paid")) {
      quotaColumn = "paid_leave_quota";
      defaultQuota = 6;
    } else if (leaveTypeLower.includes("annual")) {
      quotaColumn = "casual_leave_quota";
      defaultQuota = 25;
    }

    // 1. Quota & Attendance Synchronization
    if (status === "approved" && prevStatus !== "approved") {
      // Deduct from employee's quota
      await query(
        `UPDATE users
         SET ${quotaColumn} = GREATEST(0, COALESCE(${quotaColumn}, ${defaultQuota}) - $1),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [totalDays, updatedLeave.user_id]
      ).catch(e => console.error("Error deducting leave quota:", e));

      // Populate attendance records as 'on-leave'
      try {
        const startStr = formatDateOnly(updatedLeave.start_date);
        const endStr = formatDateOnly(updatedLeave.end_date);

        if (startStr && endStr) {
          const [y1, m1, d1] = startStr.split('-').map(Number);
          const [y2, m2, d2] = endStr.split('-').map(Number);
          let curr = new Date(Date.UTC(y1, m1 - 1, d1, 12, 0, 0));
          const endLimit = new Date(Date.UTC(y2, m2 - 1, d2, 12, 0, 0));
          while (curr <= endLimit) {
            const dayStr = curr.toISOString().split("T")[0];
            const attId = `${updatedLeave.user_id}_${dayStr}`;
            await query(
              `INSERT INTO attendance (id, user_id, company_id, date, status, notes)
               VALUES ($1, $2, $3, $4, 'on-leave', $5)
               ON CONFLICT (id) DO UPDATE SET
                 status = CASE 
                   WHEN attendance.check_in IS NOT NULL OR attendance.status IN ('present', 'late', 'half-day', 'completed', 'checked-in', 'working', 'in-progress') THEN attendance.status 
                   ELSE 'on-leave' 
                 END,
                 notes = EXCLUDED.notes,
                 updated_at = CURRENT_TIMESTAMP`,
              [attId, updatedLeave.user_id, updatedLeave.company_id, dayStr, `Approved ${updatedLeave.leave_type || "Leave"}`]
            );
            curr.setUTCDate(curr.getUTCDate() + 1);
          }
        }
      } catch (attErr) {
        console.error("Error populating on-leave attendance records:", attErr);
      }
    } else if ((status === "rejected" || status === "cancelled") && prevStatus === "approved") {
      // Restore previously deducted quota
      await query(
        `UPDATE users
         SET ${quotaColumn} = LEAST(${defaultQuota}, COALESCE(${quotaColumn}, 0) + $1),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [totalDays, updatedLeave.user_id]
      ).catch(e => console.error("Error restoring leave quota:", e));

      // Remove on-leave attendance entries
      try {
        const startStr = formatDateOnly(updatedLeave.start_date);
        const endStr = formatDateOnly(updatedLeave.end_date);

        if (startStr && endStr) {
          await query(
            `DELETE FROM attendance 
             WHERE user_id = $1 
               AND date >= $2 AND date <= $3 
               AND status = 'on-leave'`,
            [updatedLeave.user_id, startStr, endStr]
          );
        }
      } catch (attErr) {
        console.error("Error cleaning on-leave attendance records:", attErr);
      }
    }

    // Asynchronously notify the employee about leave decision
    (async () => {
      try {
        const userRes = await query("SELECT email, name FROM users WHERE id = $1", [updatedLeave.user_id]);
        if (userRes.rows.length > 0) {
          const user = userRes.rows[0];
          sendLeaveStatusEmail({
            email: user.email,
            name: user.name,
            leaveType: updatedLeave.leave_type,
            startDate: updatedLeave.start_date,
            endDate: updatedLeave.end_date,
            totalDays: updatedLeave.total_days,
            status: updatedLeave.status,
            rejectionReason: updatedLeave.rejection_reason
          }).catch(() => {});

          await sendNotificationOnce(updatedLeave.user_id, {
            title: `Leave Request ${status.toUpperCase()}`,
            message: `Your ${updatedLeave.leave_type || "leave"} request for ${totalDays} day(s) was ${status}.`,
            type: "leave",
            link: "/leaves"
          }).catch(() => {});
        }
      } catch (e) {
        console.error("Error dispatching leave status email/notification:", e);
      }
    })();

    const leaveType = updatedLeave.leave_type || "Casual Leave";
    const startDateStr = formatDateOnly(updatedLeave.start_date);
    const endDateStr = formatDateOnly(updatedLeave.end_date);

    res.json({
      ...updatedLeave,
      id: updatedLeave.id,
      _id: updatedLeave.id,
      userId: updatedLeave.user_id,
      user_id: updatedLeave.user_id,
      companyId: updatedLeave.company_id,
      company_id: updatedLeave.company_id,
      leaveType,
      leave_type: leaveType,
      type: leaveType,
      startDate: startDateStr,
      endDate: endDateStr,
      start_date: startDateStr,
      end_date: endDateStr,
      totalDays,
      total_days: totalDays,
      duration: `${totalDays} Day${totalDays > 1 ? "s" : ""}`,
      status: updatedLeave.status,
      rejectionReason: updatedLeave.rejection_reason || "",
      managerComment: updatedLeave.rejection_reason || "",
      reviewedBy: updatedLeave.reviewed_by,
      reviewedAt: updatedLeave.reviewed_at
    });
  } catch (err) {
    console.error("updateLeaveStatus error:", err);
    res.status(500).json({ error: "Failed to update leave request status." });
  }
};

export const deleteLeaveRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query("DELETE FROM leave_requests WHERE id = $1 RETURNING id", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Leave request not found." });
    }
    res.json({ message: "Leave request deleted.", id });
  } catch (err) {
    console.error("deleteLeaveRequest error:", err);
    res.status(500).json({ error: "Failed to delete leave request." });
  }
};

// Paid Leaves
export const getPaidLeaves = async (req, res) => {
  try {
    const { companyId } = req.query;
    const targetCompanyId = companyId || req.user?.companyId;

    let sql = "SELECT * FROM paid_leaves WHERE 1=1";
    const params = [];
    if (targetCompanyId) {
      params.push(targetCompanyId);
      sql += ` AND company_id = $${params.length}`;
    }
    sql += " ORDER BY start_date DESC";
    const result = await query(sql, params);
    res.json(result.rows.map(r => ({
      ...r,
      companyId: r.company_id,
      startDate: formatDateOnly(r.start_date),
      endDate: formatDateOnly(r.end_date)
    })));
  } catch (err) {
    console.error("getPaidLeaves error:", err);
    res.status(500).json({ error: "Failed to fetch paid leaves." });
  }
};

export const createPaidLeave = async (req, res) => {
  try {
    const { title, startDate, endDate, description = "", status = "active", companyId } = req.body;
    const targetCompanyId = companyId || req.user?.companyId;

    if (!title || !startDate || !endDate) {
      return res.status(400).json({ error: "Title, startDate, and endDate are required." });
    }

    const id = "paid_leave_" + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
    const result = await query(
      `INSERT INTO paid_leaves (id, company_id, title, start_date, end_date, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [id, targetCompanyId, title, startDate, endDate, description, status]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("createPaidLeave error:", err);
    res.status(500).json({ error: "Failed to create paid leave." });
  }
};

export const updatePaidLeaveStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const result = await query(
      `UPDATE paid_leaves SET status = $1 WHERE id = $2 RETURNING *`,
      [status || "active", id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Paid leave not found." });
    }
    const r = result.rows[0];
    res.json({
      ...r,
      companyId: r.company_id,
      startDate: formatDateOnly(r.start_date),
      endDate: formatDateOnly(r.end_date)
    });
  } catch (err) {
    console.error("updatePaidLeaveStatus error:", err);
    res.status(500).json({ error: "Failed to update paid leave status." });
  }
};

export const deletePaidLeave = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query("DELETE FROM paid_leaves WHERE id = $1 RETURNING id", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Paid leave not found." });
    }
    res.json({ message: "Paid leave deleted.", id });
  } catch (err) {
    console.error("deletePaidLeave error:", err);
    res.status(500).json({ error: "Failed to delete paid leave." });
  }
};

