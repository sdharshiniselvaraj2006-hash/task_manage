import crypto from "crypto";
import { query } from "../config/db.js";
import auditService from "../services/auditService.js";
import { formatDateOnly, calculateDaysBetween } from "./leaveController.js";

/**
 * Returns today's date formatted as YYYY-MM-DD in local time
 */
const getTodayDateStr = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

/**
 * Returns yesterday's date formatted as YYYY-MM-DD
 */
const getYesterdayDateStr = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/**
 * Returns date range for this week (Monday to Sunday)
 */
const getThisWeekRange = () => {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 is Sunday, 1 is Monday
  const distanceToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - distanceToMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  return {
    startDate: formatDateOnly(monday),
    endDate: formatDateOnly(sunday)
  };
};

/**
 * Returns date range for this month (1st to last day of month)
 */
const getThisMonthRange = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const firstDay = new Date(y, m, 1);
  const lastDay = new Date(y, m + 1, 0);

  return {
    startDate: formatDateOnly(firstDay),
    endDate: formatDateOnly(lastDay)
  };
};

/**
 * Parses time string (HH:MM or timestamp) to total minutes from midnight
 */
const parseTimeToMinutes = (timeVal) => {
  if (!timeVal) return null;
  if (timeVal instanceof Date) {
    if (isNaN(timeVal.getTime())) return null;
    return timeVal.getHours() * 60 + timeVal.getMinutes();
  }
  const str = String(timeVal);
  if (str.includes("T")) {
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      return d.getHours() * 60 + d.getMinutes();
    }
  }
  const m = str.match(/(\d{1,2}):(\d{2})/);
  if (m) {
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  return null;
};

/**
 * Formats time (HH:MM AM/PM) safely
 */
const formatTimeDisplay = (timeVal) => {
  if (!timeVal) return "—";
  let d;
  if (timeVal instanceof Date) {
    d = timeVal;
  } else if (typeof timeVal === "string" && timeVal.includes("T")) {
    d = new Date(timeVal);
  } else if (typeof timeVal === "string") {
    const m = timeVal.match(/(\d{1,2}):(\d{2})/);
    if (m) {
      let h = parseInt(m[1], 10);
      const min = m[2];
      const ampm = h >= 12 ? "PM" : "AM";
      h = h % 12 || 12;
      return `${String(h).padStart(2, "0")}:${min} ${ampm}`;
    }
    return timeVal;
  }
  if (!d || isNaN(d.getTime())) return "—";
  let h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${String(h).padStart(2, "0")}:${min} ${ampm}`;
};

/**
 * Processes break logs, calculates net working hours and location strings
 * for any attendance row.
 */
export const processAttendanceBreaksAndHours = (att, user = {}, targetDateStr = null) => {
  const now = new Date();
  const recDateStr = formatDateOnly(att?.date || targetDateStr || now);
  const isToday = recDateStr === getTodayDateStr();

  // 1. Parse Breaks
  let rawBreaks = [];
  if (Array.isArray(att?.breaks)) {
    rawBreaks = att.breaks;
  } else if (typeof att?.breaks === "string") {
    try {
      rawBreaks = JSON.parse(att.breaks || "[]");
    } catch {
      rawBreaks = [];
    }
  }

  let totalBreakMinutes = 0;
  let hasOngoingBreak = false;

  const processedBreaks = rawBreaks.map((b, index) => {
    const rawStart = b.start || b.startTime;
    const rawEnd = b.end || b.resumeTime;
    const bStart = rawStart ? new Date(rawStart) : null;
    const bEnd = rawEnd ? new Date(rawEnd) : null;

    let durationMins = 0;
    let isOngoing = false;

    if (bStart && bEnd && !isNaN(bStart.getTime()) && !isNaN(bEnd.getTime())) {
      durationMins = Math.max(0, Math.floor((bEnd.getTime() - bStart.getTime()) / 60000));
      totalBreakMinutes += durationMins;
    } else if (bStart && (!bEnd || isNaN(bEnd?.getTime?.()))) {
      isOngoing = true;
      hasOngoingBreak = true;
      if (isToday) {
        durationMins = Math.max(0, Math.floor((now.getTime() - bStart.getTime()) / 60000));
      } else {
        durationMins = Number(b.durationMinutes || b.duration) || 0;
      }
      totalBreakMinutes += durationMins;
    } else if (b.durationMinutes || b.duration) {
      durationMins = Number(b.durationMinutes || b.duration) || 0;
      totalBreakMinutes += durationMins;
    }

    const bStartFormatted = bStart && !isNaN(bStart.getTime()) ? formatTimeDisplay(bStart) : "—";
    const bEndFormatted = isOngoing ? "Ongoing" : (bEnd && !isNaN(bEnd.getTime()) ? formatTimeDisplay(bEnd) : "—");
    const durFormatted = isOngoing
      ? `Ongoing (${durationMins}m)`
      : (durationMins > 0 ? (durationMins >= 60 ? `${Math.floor(durationMins / 60)}h ${durationMins % 60}m` : `${durationMins}m`) : "0m");

    return {
      index: index + 1,
      breakNumber: index + 1,
      type: b.breakType || b.type || `Break ${index + 1}`,
      breakType: b.breakType || b.type || `Break ${index + 1}`,
      start: bStart ? bStart.toISOString() : (rawStart || null),
      end: bEnd ? bEnd.toISOString() : (rawEnd || null),
      startTime: bStart ? bStart.toISOString() : (rawStart || null),
      endTime: bEnd ? bEnd.toISOString() : (rawEnd || null),
      startTimeFormatted: bStartFormatted,
      endTimeFormatted: bEndFormatted,
      durationMinutes: durationMins,
      duration: durationMins,
      durationFormatted: durFormatted,
      isOngoing,
      location: b.location || b.endLocation || null,
      reason: b.reason || "break"
    };
  });

  // Extract Break 1, Break 2, Break 3
  const getBreakSlot = (idx) => {
    if (idx < processedBreaks.length) {
      const b = processedBreaks[idx];
      return {
        start: b.startTimeFormatted,
        end: b.endTimeFormatted,
        duration: b.durationFormatted,
        durationMinutes: b.durationMinutes,
        status: b.isOngoing ? "Ongoing" : "Completed",
        taken: true,
        type: b.type
      };
    }
    return {
      start: "—",
      end: "—",
      duration: "Not Taken",
      durationMinutes: 0,
      status: "Not Taken",
      taken: false,
      type: `Break ${idx + 1}`
    };
  };

  const break1 = getBreakSlot(0);
  const break2 = getBreakSlot(1);
  const break3 = getBreakSlot(2);

  // Format Total Break Duration
  const totalBreakHours = Math.floor(totalBreakMinutes / 60);
  const totalBreakRemMins = totalBreakMinutes % 60;
  const totalBreakFormatted = `${String(totalBreakHours).padStart(2, "0")}h ${String(totalBreakRemMins).padStart(2, "0")}m`;

  // 2. Locations
  const formatLoc = (locObj) => {
    if (!locObj || typeof locObj !== "object" || Object.keys(locObj).length === 0) {
      return "GPS unavailable";
    }
    if (locObj.locationName && typeof locObj.locationName === "string" && locObj.locationName.trim() && !locObj.locationName.toLowerCase().includes("unavailable")) {
      return locObj.locationName.trim();
    }
    if (locObj.latitude != null && locObj.longitude != null && !isNaN(Number(locObj.latitude)) && !isNaN(Number(locObj.longitude))) {
      return `${Number(locObj.latitude).toFixed(4)}, ${Number(locObj.longitude).toFixed(4)}`;
    }
    return "GPS unavailable";
  };

  const checkInLocationDisplay = formatLoc(att?.check_in_location || att?.location);
  const checkOutLocationDisplay = formatLoc(att?.check_out_location);

  // 3. Working Hours & Net Working Hours
  let checkInDate = att?.check_in ? new Date(att.check_in) : null;
  let checkOutDate = att?.check_out ? new Date(att.check_out) : null;

  let totalAttendanceMinutes = 0;
  if (checkInDate && !isNaN(checkInDate.getTime())) {
    if (checkOutDate && !isNaN(checkOutDate.getTime())) {
      totalAttendanceMinutes = Math.max(0, Math.floor((checkOutDate.getTime() - checkInDate.getTime()) / 60000));
      // Handle overnight shift: if checkOut is chronologically before checkIn on same date record
      if (checkOutDate < checkInDate) {
        totalAttendanceMinutes += 1440;
      }
    } else if (isToday) {
      totalAttendanceMinutes = Math.max(0, Math.floor((now.getTime() - checkInDate.getTime()) / 60000));
    } else {
      totalAttendanceMinutes = Number(att?.duration_minutes) || Number(att?.accumulated_working_minutes) || 0;
    }
  }

  // Prevent attendance duration capping past 24 hours for a single day record
  totalAttendanceMinutes = Math.min(1440, totalAttendanceMinutes);

  // Net Working Hours = Total Attendance Duration - Total Break Duration
  const netWorkingMinutes = Math.max(0, totalAttendanceMinutes - totalBreakMinutes);

  const formatHoursMins = (totalMins) => {
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    return `${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m`;
  };

  const totalAttendanceFormatted = formatHoursMins(totalAttendanceMinutes);
  const netWorkingFormatted = formatHoursMins(netWorkingMinutes);

  return {
    breaks: processedBreaks,
    totalBreaksCount: processedBreaks.length,
    hasOngoingBreak,
    break1,
    break2,
    break3,
    break1Duration: break1.duration,
    break2Duration: break2.duration,
    break3Duration: break3.duration,
    totalBreakMinutes,
    totalBreakDuration: totalBreakFormatted,
    total_break_duration: totalBreakFormatted,
    checkInLocation: checkInLocationDisplay,
    check_in_location: checkInLocationDisplay,
    checkInCoordinates: (att?.check_in_location?.latitude != null && !isNaN(Number(att.check_in_location.latitude))) ? {
      latitude: Number(att.check_in_location.latitude),
      longitude: Number(att.check_in_location.longitude),
      accuracy: att.check_in_location.accuracy ? Number(att.check_in_location.accuracy) : null
    } : null,
    checkOutLocation: checkOutLocationDisplay,
    check_out_location: checkOutLocationDisplay,
    checkOutCoordinates: (att?.check_out_location?.latitude != null && !isNaN(Number(att.check_out_location.latitude))) ? {
      latitude: Number(att.check_out_location.latitude),
      longitude: Number(att.check_out_location.longitude),
      accuracy: att.check_out_location.accuracy ? Number(att.check_out_location.accuracy) : null
    } : null,
    totalAttendanceMinutes,
    totalAttendanceDuration: totalAttendanceFormatted,
    total_attendance_duration: totalAttendanceFormatted,
    netWorkingMinutes,
    netWorkingHours: netWorkingFormatted,
    net_working_hours: netWorkingFormatted,
    netWorkingHoursDecimal: parseFloat((netWorkingMinutes / 60).toFixed(2))
  };
};

/**
 * Helper to get target company ID enforcing tenant isolation
 */
const resolveTargetCompany = (req) => {
  const isSuperAdmin = String(req.user?.role || "").toLowerCase() === "superadmin";
  const targetCompanyId = isSuperAdmin && req.query.companyId 
    ? req.query.companyId 
    : (req.user?.companyId || req.user?.company_id);
  return { isSuperAdmin, targetCompanyId };
};

/**
 * 1. Overview Dashboard Summary Statistics
 * Returns: Total Employees, Present, Absent, Late Arrivals, Currently Working,
 * Checked Out, On Leave, Pending Regularization Requests
 */
export const getAttendanceMonitoringSummary = async (req, res) => {
  try {
    const { isSuperAdmin, targetCompanyId } = resolveTargetCompany(req);
    const filterType = req.query.filterType || req.query.range || "today";
    const { department, employeeId, status } = req.query;

    let startDate = req.query.startDate;
    let endDate = req.query.endDate;

    if (filterType === "today") {
      startDate = getTodayDateStr();
      endDate = startDate;
    } else if (filterType === "yesterday") {
      startDate = getYesterdayDateStr();
      endDate = startDate;
    } else if (filterType === "this_week") {
      const week = getThisWeekRange();
      startDate = week.startDate;
      endDate = week.endDate;
    } else if (filterType === "this_month") {
      const month = getThisMonthRange();
      startDate = month.startDate;
      endDate = month.endDate;
    } else if (req.query.date) {
      startDate = req.query.date;
      endDate = req.query.date;
    } else if (!startDate || !endDate) {
      startDate = getTodayDateStr();
      endDate = startDate;
    }

    startDate = formatDateOnly(startDate);
    endDate = formatDateOnly(endDate);

    // 1. Fetch Company Users
    let userSql = `
      SELECT id, name, employee_id, department, role, shift_start, shift_end, status
      FROM users
      WHERE role NOT IN ('superadmin', 'client')
    `;
    const userParams = [];
    if (targetCompanyId) {
      userParams.push(targetCompanyId);
      userSql += ` AND company_id = $${userParams.length}`;
    }
    if (department && department !== "all") {
      userParams.push(department);
      userSql += ` AND department = $${userParams.length}`;
    }
    if (employeeId && employeeId !== "all") {
      userParams.push(employeeId);
      userSql += ` AND id = $${userParams.length}`;
    }

    const usersRes = await query(userSql, userParams);
    const users = usersRes.rows;
    const totalEmployees = users.length;
    const userIds = users.map(u => u.id);

    if (userIds.length === 0) {
      return res.json({
        totalEmployees: 0,
        presentEmployees: 0,
        absentEmployees: 0,
        lateArrivals: 0,
        currentlyWorking: 0,
        checkedOut: 0,
        onLeave: 0,
        pendingRegularization: 0,
        startDate,
        endDate,
        filterType
      });
    }

    // 2. Fetch Attendance Records for this range
    let attSql = `
      SELECT a.*, a.date::text as date_str
      FROM attendance a
      WHERE a.date >= $1 AND a.date <= $2
        AND a.user_id = ANY($3::text[])
    `;
    const attParams = [startDate, endDate, userIds];
    if (targetCompanyId) {
      attParams.push(targetCompanyId);
      attSql += ` AND a.company_id = $${attParams.length}`;
    }

    const attRes = await query(attSql, attParams);
    const attendanceRecords = attRes.rows;

    // 3. Fetch Approved Leaves for this range
    let leaveSql = `
      SELECT l.*
      FROM leave_requests l
      WHERE l.status = 'approved'
        AND l.start_date <= $2 AND l.end_date >= $1
        AND l.user_id = ANY($3::text[])
    `;
    const leaveParams = [startDate, endDate, userIds];
    if (targetCompanyId) {
      leaveParams.push(targetCompanyId);
      leaveSql += ` AND l.company_id = $${leaveParams.length}`;
    }
    const leaveRes = await query(leaveSql, leaveParams);
    const approvedLeaves = leaveRes.rows;

    // 4. Fetch Pending Regularizations
    let regSql = `
      SELECT count(*) as count
      FROM regularization_requests r
      WHERE r.status = 'pending'
        AND r.user_id = ANY($1::text[])
    `;
    const regParams = [userIds];
    if (targetCompanyId) {
      regParams.push(targetCompanyId);
      regSql += ` AND r.company_id = $${regParams.length}`;
    }
    const regRes = await query(regSql, regParams);
    const pendingRegularization = parseInt(regRes.rows[0]?.count || "0", 10);

    // 5. Aggregate metrics
    let presentCount = 0;
    let lateCount = 0;
    let currentlyWorkingCount = 0;
    let checkedOutCount = 0;
    let onLeaveCount = 0;

    // Fast user lookup
    const userMap = new Map();
    users.forEach(u => userMap.set(u.id, u));

    // Group attendance by (user_id + date)
    const attMap = new Map();
    attendanceRecords.forEach(a => {
      const d = formatDateOnly(a.date_str || a.date);
      const key = `${a.user_id}_${d}`;
      attMap.set(key, a);
    });

    // Check approved leaves coverage
    const leaveCoverage = new Set();
    approvedLeaves.forEach(l => {
      users.forEach(u => {
        if (u.id === l.user_id) {
          leaveCoverage.add(`${l.user_id}`);
        }
      });
    });
    onLeaveCount = leaveCoverage.size;

    // Evaluate each attendance log
    const evaluatedPresentUsers = new Set();

    attendanceRecords.forEach(a => {
      const u = userMap.get(a.user_id);
      const shiftStartStr = u?.shift_start || "09:00";
      const shiftStartMins = parseTimeToMinutes(shiftStartStr) || 540;

      const isLeave = a.status === "on-leave";
      const isLockedOrAbsent = a.is_admin_locked || a.status === "absent" || a.penalty_status;

      if (!isLeave && !isLockedOrAbsent && a.check_in) {
        evaluatedPresentUsers.add(a.user_id);
        presentCount++;

        // Late calculation (5-minute grace threshold)
        const inMins = parseTimeToMinutes(a.check_in);
        if (inMins !== null && inMins > (shiftStartMins + 5)) {
          lateCount++;
        }

        // Currently working vs Checked out
        if (a.check_out) {
          checkedOutCount++;
        } else {
          currentlyWorkingCount++;
        }
      }
    });

    // Absent employees
    let absentCount = 0;
    if (startDate === endDate) {
      users.forEach(u => {
        const key = `${u.id}_${startDate}`;
        const hasAtt = attMap.get(key);
        const hasLeave = approvedLeaves.some(l => {
          const lStart = formatDateOnly(l.start_date);
          const lEnd = formatDateOnly(l.end_date);
          return l.user_id === u.id && startDate >= lStart && startDate <= lEnd;
        });

        if (!hasLeave) {
          if (!hasAtt || !hasAtt.check_in || hasAtt.is_admin_locked || hasAtt.status === "absent") {
            absentCount++;
          }
        }
      });
    } else {
      absentCount = Math.max(0, totalEmployees - evaluatedPresentUsers.size - onLeaveCount);
    }

    res.json({
      totalEmployees,
      presentEmployees: presentCount,
      absentEmployees: absentCount,
      lateArrivals: lateCount,
      currentlyWorking: currentlyWorkingCount,
      checkedOut: checkedOutCount,
      onLeave: onLeaveCount,
      pendingRegularization,
      startDate,
      endDate,
      filterType
    });
  } catch (err) {
    console.error("getAttendanceMonitoringSummary error:", err);
    res.status(500).json({ error: "Failed to generate attendance summary." });
  }
};

/**
 * 2. Employee Attendance Monitoring Table Records
 * Returns detailed rows with GPS & biometric verification results,
 * shift info, late by, early departure, and action triggers.
 */
export const getAttendanceMonitoringRecords = async (req, res) => {
  try {
    const { isSuperAdmin, targetCompanyId } = resolveTargetCompany(req);
    const filterType = req.query.filterType || req.query.range || "today";
    const {
      department,
      status,
      search = "",
      page = 1,
      limit = 25,
      sortBy = "date",
      sortOrder = "desc"
    } = req.query;

    let startDate = req.query.startDate;
    let endDate = req.query.endDate;

    if (filterType === "today") {
      startDate = getTodayDateStr();
      endDate = startDate;
    } else if (filterType === "yesterday") {
      startDate = getYesterdayDateStr();
      endDate = startDate;
    } else if (filterType === "this_week") {
      const week = getThisWeekRange();
      startDate = week.startDate;
      endDate = week.endDate;
    } else if (filterType === "this_month") {
      const month = getThisMonthRange();
      startDate = month.startDate;
      endDate = month.endDate;
    } else if (req.query.date) {
      startDate = req.query.date;
      endDate = req.query.date;
    } else if (!startDate || !endDate) {
      startDate = getTodayDateStr();
      endDate = startDate;
    }

    startDate = formatDateOnly(startDate);
    endDate = formatDateOnly(endDate);

    // Fetch company settings for geofencing
    let allowedRadius = 200;
    if (targetCompanyId) {
      const compRes = await query("SELECT allowed_radius_meters FROM companies WHERE id = $1", [targetCompanyId]);
      if (compRes.rows[0]?.allowed_radius_meters) {
        allowedRadius = Number(compRes.rows[0].allowed_radius_meters);
      }
    }

    // 1. Fetch Users
    let userSql = `
      SELECT id, name, email, employee_id, department, designation, role, shift_start, shift_end, avatar_url, phone, status
      FROM users
      WHERE role NOT IN ('superadmin', 'client')
    `;
    const userParams = [];
    if (targetCompanyId) {
      userParams.push(targetCompanyId);
      userSql += ` AND company_id = $${userParams.length}`;
    }
    if (department && department !== "all") {
      userParams.push(department);
      userSql += ` AND department = $${userParams.length}`;
    }
    if (search.trim()) {
      userParams.push(`%${search.trim()}%`);
      userSql += ` AND (name ILIKE $${userParams.length} OR email ILIKE $${userParams.length} OR employee_id ILIKE $${userParams.length})`;
    }

    userSql += " ORDER BY name ASC";
    const userRes = await query(userSql, userParams);
    const users = userRes.rows;
    const userIds = users.map(u => u.id);

    // Fetch tenant distinct departments
    let deptSql = "SELECT DISTINCT department FROM users WHERE department IS NOT NULL";
    const deptParams = [];
    if (targetCompanyId) {
      deptSql += " AND company_id = $1";
      deptParams.push(targetCompanyId);
    }
    const deptRes = await query(deptSql, deptParams);
    const departments = deptRes.rows.map(r => r.department).filter(Boolean).sort();

    if (userIds.length === 0) {
      return res.json({
        records: [],
        departments,
        pagination: {
          total: 0,
          page: Number(page),
          limit: Number(limit),
          totalPages: 0
        },
        startDate,
        endDate,
        filterType
      });
    }

    const userMap = new Map();
    users.forEach(u => userMap.set(u.id, u));

    // 2. Fetch Attendance for Date Range
    let attSql = `
      SELECT a.*, a.date::text as date_str
      FROM attendance a
      WHERE a.date >= $1 AND a.date <= $2
        AND a.user_id = ANY($3::text[])
    `;
    const attParams = [startDate, endDate, userIds];
    if (targetCompanyId) {
      attParams.push(targetCompanyId);
      attSql += ` AND a.company_id = $${attParams.length}`;
    }
    attSql += " ORDER BY a.date DESC, a.check_in DESC NULLS LAST";
    const attRes = await query(attSql, attParams);
    const attendanceRecords = attRes.rows;

    // 3. Fetch Approved Leaves for Date Range
    let leaveSql = `
      SELECT l.*
      FROM leave_requests l
      WHERE l.status = 'approved'
        AND l.start_date <= $2 AND l.end_date >= $1
        AND l.user_id = ANY($3::text[])
    `;
    const leaveParams = [startDate, endDate, userIds];
    if (targetCompanyId) {
      leaveParams.push(targetCompanyId);
      leaveSql += ` AND l.company_id = $${leaveParams.length}`;
    }
    const leaveRes = await query(leaveSql, leaveParams);
    const leaveRecords = leaveRes.rows;

    // 4. Fetch Regularizations for Date Range
    let regSql = `
      SELECT r.*
      FROM regularization_requests r
      WHERE r.attendance_date >= $1 AND r.attendance_date <= $2
        AND r.user_id = ANY($3::text[])
    `;
    const regParams = [startDate, endDate, userIds];
    if (targetCompanyId) {
      regParams.push(targetCompanyId);
      regSql += ` AND r.company_id = $${regParams.length}`;
    }
    const regRes = await query(regSql, regParams);
    const regMap = new Map();
    regRes.rows.forEach(r => {
      const d = formatDateOnly(r.attendance_date);
      regMap.set(`${r.user_id}_${d}`, r);
    });

    // 5. Fetch Verification Attempts for Date Range
    let avaSql = `
      SELECT ava.*
      FROM attendance_verification_attempts ava
      WHERE ava.attempted_at::date >= $1::date AND ava.attempted_at::date <= $2::date
        AND ava.user_id = ANY($3::text[])
      ORDER BY ava.attempted_at DESC
    `;
    const avaRes = await query(avaSql, [startDate, endDate, userIds]);
    const avaMap = new Map();
    avaRes.rows.forEach(v => {
      const d = formatDateOnly(v.attempted_at);
      const key = `${v.user_id}_${d}`;
      if (!avaMap.has(key)) avaMap.set(key, v);
    });

    // 6. Paid Holidays in range
    let holidayMap = new Map();
    if (targetCompanyId) {
      const holRes = await query(
        `SELECT title, start_date, end_date FROM paid_leaves WHERE status = 'active' AND start_date <= $2 AND end_date >= $1 AND (company_id = $3 OR company_id IS NULL)`,
        [startDate, endDate, targetCompanyId]
      );
      holRes.rows.forEach(h => {
        holidayMap.set(formatDateOnly(h.start_date), h.title);
      });
    }

    // Helper to format a single record
    const formatRecordRow = (user, att, recDate) => {
      const dStr = formatDateOnly(recDate);
      const reg = regMap.get(`${user.id}_${dStr}`);
      const ava = avaMap.get(`${user.id}_${dStr}`);

      const leave = leaveRecords.find(l => {
        const lStart = formatDateOnly(l.start_date);
        const lEnd = formatDateOnly(l.end_date);
        return l.user_id === user.id && dStr >= lStart && dStr <= lEnd;
      });

      const shiftStartStr = user.shift_start || "09:00";
      const shiftEndStr = user.shift_end || "18:00";
      const shiftDisplay = `${formatTimeDisplay(shiftStartStr)} - ${formatTimeDisplay(shiftEndStr)}`;

      const shiftStartMins = parseTimeToMinutes(shiftStartStr) || 540;
      const shiftEndMins = parseTimeToMinutes(shiftEndStr) || 1080;

      const breakCalc = processAttendanceBreaksAndHours(att, user, dStr);

      let checkInTime = null;
      let checkOutTime = null;
      let workingHoursStr = breakCalc.netWorkingHours;
      let workingHoursDec = breakCalc.netWorkingHoursDecimal;
      let workingMinutes = breakCalc.netWorkingMinutes;
      let lateMinutes = 0;
      let earlyDepartureMinutes = 0;

      if (att && att.check_in) {
        checkInTime = att.check_in;
        checkOutTime = att.check_out || null;

        const inMins = parseTimeToMinutes(checkInTime);
        if (inMins !== null && inMins > shiftStartMins) {
          lateMinutes = inMins - shiftStartMins;
        }

        if (checkOutTime) {
          const outMins = parseTimeToMinutes(checkOutTime);
          if (outMins !== null && outMins < shiftEndMins) {
            earlyDepartureMinutes = shiftEndMins - outMins;
          }
        }
      }

      // GPS Verification Result
      let gpsVerification = "Not Available";
      if (att && (att.fence_verified_at || (att.distance_from_office_meters != null && Number(att.distance_from_office_meters) <= allowedRadius))) {
        gpsVerification = "Verified";
      } else if (att && att.distance_from_office_meters != null && Number(att.distance_from_office_meters) > allowedRadius) {
        gpsVerification = "Failed";
      } else if (att?.check_in_location && typeof att.check_in_location === "object" && Object.keys(att.check_in_location).length > 0) {
        const accuracy = Number(att.check_in_location.accuracy);
        if (accuracy > 150) {
          gpsVerification = "Accuracy Insufficient";
        } else {
          gpsVerification = "Verified";
        }
      } else if (ava?.gps_result) {
        if (ava.gps_result === "verified" || ava.gps_result === "within_geofence") gpsVerification = "Verified";
        else if (ava.gps_result === "outside_geofence" || ava.gps_result === "failed") gpsVerification = "Failed";
      }

      // Face Verification Result
      let faceVerification = "Not Available";
      if (att && att.biometric_verified && att.liveness_passed) {
        faceVerification = "Verified";
      } else if (att && att.biometric_verified === false && att.verification_score != null) {
        faceVerification = "Failed";
      } else if (ava) {
        if (ava.status === "passed" || ava.face_result === "match") faceVerification = "Verified";
        else if (ava.status === "failed" || ava.face_result === "mismatch") faceVerification = "Failed";
        else if (ava.status === "inconclusive") faceVerification = "Inconclusive";
      }

      // Attendance Status Resolution
      const dateObj = new Date(dStr + "T00:00:00");
      const dayOfWeek = dateObj.getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      const isHoliday = holidayMap.has(dStr);

      let attendanceStatus = "Absent";
      if (att?.is_admin_locked) {
        attendanceStatus = "Attendance Locked";
      } else if (leave || att?.status === "on-leave") {
        attendanceStatus = "On Leave";
      } else if (att?.status === "absent" || att?.absence_reason || att?.penalty_status) {
        attendanceStatus = "Absent";
      } else if (checkInTime) {
        if (checkOutTime) {
          if (workingMinutes < 270) {
            attendanceStatus = "Half Day";
          } else if (lateMinutes > 5) {
            attendanceStatus = "Late";
          } else {
            attendanceStatus = "Present";
          }
        } else {
          if (dStr === getTodayDateStr()) {
            attendanceStatus = lateMinutes > 5 ? "Late" : "Present";
          } else {
            attendanceStatus = "Incomplete Check-out";
          }
        }
      } else if (isHoliday) {
        attendanceStatus = "Holiday";
      } else if (isWeekend) {
        attendanceStatus = "Weekly Off";
      } else if (dStr === getTodayDateStr()) {
        const now = new Date();
        const currentMins = now.getHours() * 60 + now.getMinutes();
        if (currentMins < shiftStartMins) {
          attendanceStatus = "Pending";
        } else if (currentMins > shiftStartMins + 15) {
          attendanceStatus = "Late";
        } else {
          attendanceStatus = "Pending";
        }
      }

      const checkInFormatted = formatTimeDisplay(checkInTime);
      const checkOutFormatted = formatTimeDisplay(checkOutTime);
      const lateFormatted = lateMinutes > 0 ? `${lateMinutes}m` : "0m";
      const earlyFormatted = earlyDepartureMinutes > 0 ? `${earlyDepartureMinutes}m` : "0m";
      const isLocked = Boolean(att?.is_admin_locked);
      const dist = (att && att.distance_from_office_meters != null) ? Number(att.distance_from_office_meters) : null;

      return {
        id: att?.id || `sim_${user.id}_${dStr}`,
        recordId: att?.id || `sim_${user.id}_${dStr}`,
        attendanceId: att?.id || null,
        userId: user.id,
        user_id: user.id,
        empId: user.employee_id || `EMP-${user.id.slice(-4).toUpperCase()}`,
        employeeId: user.employee_id || `EMP-${user.id.slice(-4).toUpperCase()}`,
        employee_id: user.employee_id || `EMP-${user.id.slice(-4).toUpperCase()}`,
        name: user.name || "Employee",
        employeeName: user.name || "Employee",
        user_name: user.name || "Employee",
        email: user.email,
        phone: user.phone || "—",
        department: user.department || "General",
        designation: user.designation || "Staff",
        avatarUrl: user.avatar_url || null,
        avatar_url: user.avatar_url || null,
        shift: shiftDisplay,
        shift_name: shiftDisplay,
        shiftStart: shiftStartStr,
        shift_start: shiftStartStr,
        shiftEnd: shiftEndStr,
        shift_end: shiftEndStr,
        date: dStr,
        date_formatted: dStr,
        checkIn: checkInFormatted,
        check_in: checkInFormatted,
        check_in_formatted: checkInFormatted,
        check_in_time: checkInFormatted !== "—" ? checkInFormatted : null,
        checkInRaw: checkInTime,
        checkOut: checkOutFormatted,
        check_out: checkOutFormatted,
        check_out_formatted: checkOutFormatted,
        check_out_time: checkOutFormatted !== "—" ? checkOutFormatted : null,
        checkOutRaw: checkOutTime,
        workingHours: workingHoursStr,
        working_hours: workingHoursDec,
        working_hours_formatted: workingHoursStr,
        workingMinutes,
        // Detailed Breaks Breakdown
        break1: breakCalc.break1,
        break2: breakCalc.break2,
        break3: breakCalc.break3,
        break1Duration: breakCalc.break1.duration,
        break2Duration: breakCalc.break2.duration,
        break3Duration: breakCalc.break3.duration,
        break_1_duration: breakCalc.break1.duration,
        break_2_duration: breakCalc.break2.duration,
        break_3_duration: breakCalc.break3.duration,
        totalBreaksCount: breakCalc.totalBreaksCount,
        total_breaks_count: breakCalc.totalBreaksCount,
        totalBreakMinutes: breakCalc.totalBreakMinutes,
        total_break_minutes: breakCalc.totalBreakMinutes,
        totalBreakDuration: breakCalc.totalBreakDuration,
        total_break_duration: breakCalc.totalBreakDuration,
        breaks: breakCalc.breaks,
        allBreaks: breakCalc.breaks,
        hasOngoingBreak: breakCalc.hasOngoingBreak,
        // Check-in and Check-out Locations
        checkInLocation: breakCalc.checkInLocation,
        check_in_location: breakCalc.check_in_location,
        checkInCoordinates: breakCalc.checkInCoordinates,
        checkOutLocation: breakCalc.checkOutLocation,
        check_out_location: breakCalc.check_out_location,
        checkOutCoordinates: breakCalc.checkOutCoordinates,
        // Net Working Hours & Duration
        totalAttendanceMinutes: breakCalc.totalAttendanceMinutes,
        total_attendance_minutes: breakCalc.totalAttendanceMinutes,
        totalAttendanceDuration: breakCalc.totalAttendanceDuration,
        total_attendance_duration: breakCalc.totalAttendanceDuration,
        netWorkingMinutes: breakCalc.netWorkingMinutes,
        net_working_minutes: breakCalc.netWorkingMinutes,
        netWorkingHours: breakCalc.netWorkingHours,
        net_working_hours: breakCalc.netWorkingHours,
        lateByMinutes: lateMinutes,
        late_minutes: lateMinutes,
        lateByText: lateFormatted,
        late_by_formatted: lateFormatted,
        earlyDepartureMinutes,
        early_departure_minutes: earlyDepartureMinutes,
        earlyDepartureText: earlyFormatted,
        early_departure_formatted: earlyFormatted,
        gpsVerification,
        gps_verification_status: gpsVerification,
        gpsStatus: gpsVerification,
        faceVerification,
        face_verification_status: faceVerification,
        faceStatus: faceVerification,
        attendanceStatus,
        attendance_status: attendanceStatus,
        status: attendanceStatus,
        isRegularized: Boolean(att?.is_regularized || reg?.status === "approved"),
        regularizationStatus: reg?.status || null,
        regularizationId: reg?.id || null,
        adminNotes: att?.admin_notes || null,
        admin_notes: att?.admin_notes || null,
        admin_remarks: att?.admin_notes || null,
        isAdminLocked: isLocked,
        is_admin_locked: isLocked,
        locked: isLocked,
        attendance_locked: isLocked,
        distanceMeters: dist,
        distance_from_office_meters: dist,
        location: att?.check_in_location || att?.location || null
      };
    };

    let allRecords = [];

    // Map all actual database attendance records
    const coveredUserDateKeys = new Set();
    attendanceRecords.forEach(att => {
      const u = userMap.get(att.user_id);
      if (u) {
        const dStr = formatDateOnly(att.date_str || att.date);
        coveredUserDateKeys.add(`${u.id}_${dStr}`);
        allRecords.push(formatRecordRow(u, att, dStr));
      }
    });

    // If single day view, or for today in range:
    // Ensure every scheduled company user has an entry
    const targetSingleDate = (startDate === endDate) ? startDate : (getTodayDateStr() >= startDate && getTodayDateStr() <= endDate ? getTodayDateStr() : null);
    if (targetSingleDate) {
      users.forEach(u => {
        const key = `${u.id}_${targetSingleDate}`;
        if (!coveredUserDateKeys.has(key)) {
          allRecords.push(formatRecordRow(u, null, targetSingleDate));
        }
      });
    }

    // Filter by status if requested
    if (status && status !== "all") {
      const sLower = status.toLowerCase();
      allRecords = allRecords.filter(r => r.attendanceStatus.toLowerCase() === sLower || r.status.toLowerCase() === sLower);
    }

    // Sort
    allRecords.sort((a, b) => {
      let valA = a[sortBy] !== undefined ? a[sortBy] : a.date;
      let valB = b[sortBy] !== undefined ? b[sortBy] : b.date;
      if (valA === undefined) valA = "";
      if (valB === undefined) valB = "";
      if (typeof valA === "string") {
        return sortOrder === "asc" ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      return sortOrder === "asc" ? (valA > valB ? 1 : -1) : (valA < valB ? 1 : -1);
    });

    // Pagination
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 25);
    const totalRecords = allRecords.length;
    const totalPages = Math.ceil(totalRecords / limitNum);
    const paginatedRecords = allRecords.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    res.json({
      records: paginatedRecords,
      departments,
      pagination: {
        total: totalRecords,
        page: pageNum,
        limit: limitNum,
        totalPages
      },
      startDate,
      endDate,
      filterType
    });
  } catch (err) {
    console.error("getAttendanceMonitoringRecords error:", err);
    res.status(500).json({ error: "Failed to fetch attendance monitoring records." });
  }
};

/**
 * 3. Live Attendance Monitoring Snapshot
 * Real-time view for Today showing:
 * - Employees currently checked in (working)
 * - Employees not checked in
 * - Employees checked out
 * - Employees who are late
 * - Employees whose verification is pending
 */
export const getLiveAttendanceMonitoring = async (req, res) => {
  try {
    const { isSuperAdmin, targetCompanyId } = resolveTargetCompany(req);
    const todayStr = getTodayDateStr();

    // 1. Fetch Users
    let userSql = `
      SELECT id, name, email, employee_id, department, designation, shift_start, shift_end, avatar_url
      FROM users
      WHERE role NOT IN ('superadmin', 'client')
    `;
    const userParams = [];
    if (targetCompanyId) {
      userParams.push(targetCompanyId);
      userSql += ` AND company_id = $${userParams.length}`;
    }
    userSql += " ORDER BY name ASC";
    const userRes = await query(userSql, userParams);
    const users = userRes.rows;
    const userIds = users.map(u => u.id);

    if (userIds.length === 0) {
      return res.json({
        lastRefreshedAt: new Date().toISOString(),
        summary: { working: 0, notCheckedIn: 0, checkedOut: 0, late: 0, pendingReview: 0 },
        categories: { working: [], notCheckedIn: [], checkedOut: [], late: [], pendingReview: [] }
      });
    }

    // 2. Fetch Today's Attendance
    const attSql = `
      SELECT a.*, a.date::text as date_str
      FROM attendance a
      WHERE a.date = $1
        AND a.user_id = ANY($2::text[])
    `;
    const attRes = await query(attSql, [todayStr, userIds]);
    const attMap = new Map();
    attRes.rows.forEach(r => attMap.set(r.user_id, r));

    // 3. Fetch Today's Approved Leaves
    const leaveSql = `
      SELECT l.*
      FROM leave_requests l
      WHERE l.status = 'approved'
        AND l.start_date <= $1 AND l.end_date >= $1
        AND l.user_id = ANY($2::text[])
    `;
    const leaveRes = await query(leaveSql, [todayStr, userIds]);
    const leaveMap = new Map();
    leaveRes.rows.forEach(l => leaveMap.set(l.user_id, l));

    // 4. Fetch Pending Verification Attempts for Today
    const pendingAvaSql = `
      SELECT ava.*, u.name as user_name, u.department
      FROM attendance_verification_attempts ava
      LEFT JOIN users u ON ava.user_id = u.id
      WHERE ava.attempted_at::date = $1::date
        AND ava.review_status = 'pending'
        AND ava.user_id = ANY($2::text[])
    `;
    const pendingAvaRes = await query(pendingAvaSql, [todayStr, userIds]);
    const pendingReviewList = pendingAvaRes.rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      name: r.user_name || "Employee",
      department: r.department || "General",
      attemptedAt: r.attempted_at,
      status: r.status,
      failureCategory: r.failure_category,
      gpsResult: r.gps_result,
      faceResult: r.face_result
    }));

    // 5. Categorize Live Status
    const workingList = [];
    const notCheckedInList = [];
    const checkedOutList = [];
    const lateList = [];

    const now = new Date();
    const currentMins = now.getHours() * 60 + now.getMinutes();

    users.forEach(user => {
      const att = attMap.get(user.id);
      const leave = leaveMap.get(user.id);

      const shiftStartStr = user.shift_start || "09:00";
      const shiftEndStr = user.shift_end || "18:00";
      const shiftStartMins = parseTimeToMinutes(shiftStartStr) || 540;

      const baseInfo = {
        userId: user.id,
        name: user.name,
        employeeId: user.employee_id || `EMP-${user.id.slice(-4).toUpperCase()}`,
        department: user.department || "General",
        designation: user.designation || "Staff",
        shift: `${formatTimeDisplay(shiftStartStr)} - ${formatTimeDisplay(shiftEndStr)}`,
        avatarUrl: user.avatar_url || null
      };

      if (leave) {
        // Handled as on leave
        return;
      }

      if (att && att.check_in) {
        const inMins = parseTimeToMinutes(att.check_in);
        const isLate = inMins !== null && inMins > (shiftStartMins + 5);

        if (isLate) {
          lateList.push({
            ...baseInfo,
            checkIn: formatTimeDisplay(att.check_in),
            checkInTime: att.check_in,
            lateMinutes: inMins - shiftStartMins
          });
        }

        if (att.check_out) {
          checkedOutList.push({
            ...baseInfo,
            checkIn: formatTimeDisplay(att.check_in),
            checkOut: formatTimeDisplay(att.check_out),
            workingMinutes: att.duration_minutes || 0
          });
        } else {
          workingList.push({
            ...baseInfo,
            checkIn: formatTimeDisplay(att.check_in),
            checkInTime: att.check_in,
            isLate
          });
        }
      } else {
        // Not checked in yet
        const isPastShift = currentMins > (shiftStartMins + 15);
        if (isPastShift) {
          lateList.push({
            ...baseInfo,
            checkIn: "Not Checked In",
            checkInTime: null,
            lateMinutes: currentMins - shiftStartMins
          });
        }
        notCheckedInList.push({
          ...baseInfo,
          isPastShift,
          minutesOverdue: isPastShift ? currentMins - shiftStartMins : 0
        });
      }
    });

    res.json({
      lastRefreshedAt: new Date().toISOString(),
      summary: {
        working: workingList.length,
        notCheckedIn: notCheckedInList.length,
        checkedOut: checkedOutList.length,
        late: lateList.length,
        pendingReview: pendingReviewList.length
      },
      categories: {
        working: workingList,
        notCheckedIn: notCheckedInList,
        checkedOut: checkedOutList,
        late: lateList,
        pendingReview: pendingReviewList
      }
    });
  } catch (err) {
    console.error("getLiveAttendanceMonitoring error:", err);
    res.status(500).json({ error: "Failed to fetch live attendance monitoring." });
  }
};

/**
 * 4. Individual Employee Attendance Profile
 * Detailed profile containing:
 * - Employee info, department, shift
 * - Daily attendance history
 * - Late arrival & early departure metrics
 * - GPS verification records (office coords, geofence radius, user coords, distance)
 * - Biometric verification records (without exposing raw templates)
 * - Regularization history
 * - Admin remarks and audit logs
 */
export const getEmployeeAttendanceProfile = async (req, res) => {
  try {
    const { isSuperAdmin, targetCompanyId } = resolveTargetCompany(req);
    const { userId } = req.params;
    const { days = 60, startDate: qStartDate, endDate: qEndDate } = req.query;

    if (!userId) {
      return res.status(400).json({ error: "User ID is required." });
    }

    // 1. Fetch User Record
    const userRes = await query(
      `SELECT id, company_id, name, email, employee_id, role, department, designation, shift_start, shift_end, avatar_url, phone, status, created_at
       FROM users
       WHERE id = $1 ${!isSuperAdmin && targetCompanyId ? "AND company_id = $2" : ""}`,
      !isSuperAdmin && targetCompanyId ? [userId, targetCompanyId] : [userId]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "Employee not found or access denied." });
    }
    const user = userRes.rows[0];

    // 2. Fetch Company Office Location Settings
    let officeLocation = null;
    let allowedRadius = 200;
    if (user.company_id) {
      const compRes = await query(
        `SELECT name, latitude, longitude, allowed_radius_meters FROM companies WHERE id = $1`,
        [user.company_id]
      );
      if (compRes.rows.length > 0) {
        const c = compRes.rows[0];
        officeLocation = {
          name: c.name,
          latitude: c.latitude ? Number(c.latitude) : null,
          longitude: c.longitude ? Number(c.longitude) : null,
          radiusMeters: c.allowed_radius_meters ? Number(c.allowed_radius_meters) : 200
        };
        allowedRadius = officeLocation.radiusMeters;
      }
    }

    // 3. Fetch Attendance History
    let attendanceHistory = [];
    let startDate = qStartDate ? formatDateOnly(qStartDate) : null;
    let endDate = qEndDate ? formatDateOnly(qEndDate) : null;

    if (startDate && endDate) {
      const attSql = `
        SELECT a.*, a.date::text as date_str
        FROM attendance a
        WHERE a.user_id = $1 AND a.date >= $2 AND a.date <= $3
        ORDER BY a.date DESC
      `;
      const attRes = await query(attSql, [userId, startDate, endDate]);
      attendanceHistory = attRes.rows;
    } else {
      const attSql = `
        SELECT a.*, a.date::text as date_str
        FROM attendance a
        WHERE a.user_id = $1
        ORDER BY a.date DESC
        LIMIT $2
      `;
      const attRes = await query(attSql, [userId, Math.min(Number(days) || 60, 180)]);
      attendanceHistory = attRes.rows;
    }

    // 4. Fetch Verification Attempts (Biometric & GPS)
    const avaSql = `
      SELECT id, attempted_at, work_mode, status, failure_category,
             gps_result, face_result, liveness_result, review_status, review_decision, review_note, metadata
      FROM attendance_verification_attempts
      WHERE user_id = $1
      ORDER BY attempted_at DESC
      LIMIT 30
    `;
    const avaRes = await query(avaSql, [userId]);
    const verificationAttempts = avaRes.rows;

    // 5. Fetch Regularization Requests
    const regSql = `
      SELECT r.*, r.attendance_date::text as date_str
      FROM regularization_requests r
      WHERE r.user_id = $1
      ORDER BY r.created_at DESC
      LIMIT 30
    `;
    const regRes = await query(regSql, [userId]);
    const regularizationHistory = regRes.rows.map(r => ({
      id: r.id,
      date: formatDateOnly(r.date_str || r.attendance_date),
      requestedCheckIn: formatTimeDisplay(r.requested_check_in),
      requestedCheckOut: formatTimeDisplay(r.requested_check_out),
      reason: r.reason || "—",
      status: r.status,
      managerComment: r.manager_comment || r.rejection_reason || "—",
      appliedAt: r.created_at
    }));

    // 6. Fetch Audit History regarding this employee
    const auditSql = `
      SELECT id, action, details, created_at, user_name, user_role
      FROM audit_logs
      WHERE resource_id = $1 OR details->>'employeeId' = $1 OR details->>'userId' = $1
      ORDER BY created_at DESC
      LIMIT 20
    `;
    const auditRes = await query(auditSql, [userId]);
    const auditHistory = auditRes.rows;

    // 7. Calculate Aggregates & Process Breaks for Profile
    const shiftStartStr = user.shift_start || "09:00";
    const shiftEndStr = user.shift_end || "18:00";
    const shiftStartMins = parseTimeToMinutes(shiftStartStr) || 540;
    const shiftEndMins = parseTimeToMinutes(shiftEndStr) || 1080;

    let presentDays = 0;
    let lateDays = 0;
    let absentDays = 0;
    let halfDays = 0;
    let onLeaveDays = 0;
    let totalNetWorkingMinutes = 0;
    let totalAllBreaksMinutes = 0;

    const formattedHistory = attendanceHistory.map(a => {
      const dStr = formatDateOnly(a.date_str || a.date);
      const breakCalc = processAttendanceBreaksAndHours(a, user, dStr);

      totalNetWorkingMinutes += breakCalc.netWorkingMinutes;
      totalAllBreaksMinutes += breakCalc.totalBreakMinutes;

      let lateMins = 0;
      let earlyMins = 0;

      if (a.check_in) {
        const inMins = parseTimeToMinutes(a.check_in);
        if (inMins !== null && inMins > (shiftStartMins + 5)) {
          lateMins = inMins - shiftStartMins;
          lateDays++;
        }
        presentDays++;
      }

      if (a.check_out) {
        const outMins = parseTimeToMinutes(a.check_out);
        if (outMins !== null && outMins < shiftEndMins) {
          earlyMins = shiftEndMins - outMins;
        }
      }

      let status = a.status || "Present";
      if (a.status === "on-leave") {
        onLeaveDays++;
        status = "On Leave";
      } else if (a.status === "absent" || a.is_admin_locked) {
        absentDays++;
        status = a.is_admin_locked ? "Attendance Locked" : "Absent";
      } else if (breakCalc.netWorkingMinutes > 0 && breakCalc.netWorkingMinutes < 270) {
        halfDays++;
        status = "Half Day";
      } else if (lateMins > 0) {
        status = "Late";
      }

      // GPS verification status
      let gpsStatus = "Not Available";
      if (a.fence_verified_at || (a.distance_from_office_meters != null && Number(a.distance_from_office_meters) <= allowedRadius)) {
        gpsStatus = "Verified";
      } else if (a.distance_from_office_meters != null && Number(a.distance_from_office_meters) > allowedRadius) {
        gpsStatus = "Failed";
      }

      return {
        id: a.id,
        date: dStr,
        date_formatted: dStr,
        checkIn: formatTimeDisplay(a.check_in),
        check_in: formatTimeDisplay(a.check_in),
        checkInTime: formatTimeDisplay(a.check_in),
        checkOut: formatTimeDisplay(a.check_out),
        check_out: formatTimeDisplay(a.check_out),
        checkOutTime: formatTimeDisplay(a.check_out),
        checkInRaw: a.check_in,
        checkOutRaw: a.check_out,
        // Detailed Breaks
        break1: breakCalc.break1,
        break2: breakCalc.break2,
        break3: breakCalc.break3,
        break1Duration: breakCalc.break1.duration,
        break2Duration: breakCalc.break2.duration,
        break3Duration: breakCalc.break3.duration,
        totalBreaksCount: breakCalc.totalBreaksCount,
        totalBreakMinutes: breakCalc.totalBreakMinutes,
        totalBreakDuration: breakCalc.totalBreakDuration,
        total_break_duration: breakCalc.totalBreakDuration,
        breaks: breakCalc.breaks,
        hasOngoingBreak: breakCalc.hasOngoingBreak,
        // Locations
        checkInLocation: breakCalc.checkInLocation,
        check_in_location: breakCalc.check_in_location,
        checkInCoordinates: breakCalc.checkInCoordinates,
        checkOutLocation: breakCalc.checkOutLocation,
        check_out_location: breakCalc.check_out_location,
        checkOutCoordinates: breakCalc.checkOutCoordinates,
        // Hours
        totalAttendanceDuration: breakCalc.totalAttendanceDuration,
        total_attendance_duration: breakCalc.totalAttendanceDuration,
        totalAttendanceMinutes: breakCalc.totalAttendanceMinutes,
        netWorkingHours: breakCalc.netWorkingHours,
        net_working_hours: breakCalc.netWorkingHours,
        netWorkingMinutes: breakCalc.netWorkingMinutes,
        workingHours: breakCalc.netWorkingHours,
        working_hours: breakCalc.netWorkingHoursDecimal,
        lateMinutes: lateMins,
        earlyDepartureMinutes: earlyMins,
        status,
        attendanceStatus: status,
        attendance_status: status,
        gpsStatus,
        gpsVerification: gpsStatus,
        distanceMeters: a.distance_from_office_meters ? Number(a.distance_from_office_meters) : null,
        biometricVerified: Boolean(a.biometric_verified),
        livenessPassed: Boolean(a.liveness_passed),
        adminNotes: a.admin_notes,
        isLocked: Boolean(a.is_admin_locked)
      };
    });

    const totalNetH = Math.floor(totalNetWorkingMinutes / 60);
    const totalNetM = totalNetWorkingMinutes % 60;
    const totalNetWorkingFormatted = `${String(totalNetH).padStart(2, "0")}h ${String(totalNetM).padStart(2, "0")}m`;

    const totalBrkH = Math.floor(totalAllBreaksMinutes / 60);
    const totalBrkM = totalAllBreaksMinutes % 60;
    const totalBreakDurationFormatted = `${String(totalBrkH).padStart(2, "0")}h ${String(totalBrkM).padStart(2, "0")}m`;

    const avgMins = presentDays > 0 ? Math.floor(totalNetWorkingMinutes / presentDays) : 0;
    const avgH = Math.floor(avgMins / 60);
    const avgM = avgMins % 60;
    const avgHoursPerDayFormatted = `${String(avgH).padStart(2, "0")}h ${String(avgM).padStart(2, "0")}m`;
    const avgHoursDec = presentDays > 0 ? (totalNetWorkingMinutes / presentDays / 60).toFixed(2) : "0.00";

    res.json({
      employee: {
        id: user.id,
        name: user.name,
        employeeName: user.name,
        email: user.email,
        employeeId: user.employee_id || `EMP-${user.id.slice(-4).toUpperCase()}`,
        empId: user.employee_id || `EMP-${user.id.slice(-4).toUpperCase()}`,
        role: user.role,
        department: user.department || "General",
        designation: user.designation || "Staff",
        shift: `${formatTimeDisplay(shiftStartStr)} - ${formatTimeDisplay(shiftEndStr)}`,
        shift_name: `${formatTimeDisplay(shiftStartStr)} - ${formatTimeDisplay(shiftEndStr)}`,
        shiftStart: shiftStartStr,
        shift_start: shiftStartStr,
        shiftEnd: shiftEndStr,
        shift_end: shiftEndStr,
        avatarUrl: user.avatar_url,
        avatar_url: user.avatar_url,
        phone: user.phone || "—",
        status: user.status
      },
      officeLocation,
      summary: {
        totalLoggedDays: formattedHistory.length,
        totalWorkingDays: formattedHistory.length,
        presentDays,
        totalPresentDays: presentDays,
        lateDays,
        totalLateArrivals: lateDays,
        absentDays,
        totalAbsentDays: absentDays,
        halfDays,
        onLeaveDays,
        totalBreakMinutes: totalAllBreaksMinutes,
        totalBreakDuration: totalBreakDurationFormatted,
        totalNetWorkingMinutes,
        totalNetWorkingHours: totalNetWorkingFormatted,
        totalWorkingHours: (totalNetWorkingMinutes / 60).toFixed(2),
        avgHoursPerDay: avgHoursDec,
        avgDailyWorkingHours: avgHoursPerDayFormatted
      },
      history: formattedHistory,
      verificationAttempts,
      regularizationHistory,
      auditHistory
    });
  } catch (err) {
    console.error("getEmployeeAttendanceProfile error:", err);
    res.status(500).json({ error: "Failed to fetch employee attendance profile." });
  }
};

/**
 * 4. Individual Employee Attendance Report Download / Data Export
 * Generates structured JSON or CSV containing Employee Info, Summary Statistics,
 * and Daily Attendance Records with breaks and locations.
 */
export const getEmployeeAttendanceReport = async (req, res) => {
  try {
    const { isSuperAdmin, targetCompanyId } = resolveTargetCompany(req);
    const { userId } = req.params;
    let { startDate, endDate, range, format = "json" } = req.query;

    if (!userId) {
      return res.status(400).json({ error: "User ID is required." });
    }

    // 1. Fetch User Record
    const userRes = await query(
      `SELECT id, company_id, name, email, employee_id, role, department, designation, shift_start, shift_end, phone, status
       FROM users
       WHERE id = $1 ${!isSuperAdmin && targetCompanyId ? "AND company_id = $2" : ""}`,
      !isSuperAdmin && targetCompanyId ? [userId, targetCompanyId] : [userId]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "Employee not found or access denied." });
    }
    const user = userRes.rows[0];

    // Fetch company allowed radius
    let allowedRadius = 200;
    if (user.company_id) {
      const compRes = await query(
        `SELECT allowed_radius_meters FROM companies WHERE id = $1`,
        [user.company_id]
      );
      if (compRes.rows[0]?.allowed_radius_meters) {
        allowedRadius = Number(compRes.rows[0].allowed_radius_meters);
      }
    }

    // Date range resolution: today, this_week, this_month, custom, all
    let rangeType = range || "custom";
    let isAllRecords = rangeType === "all" || startDate === "all" || (!startDate && !endDate && req.query.all === "true");

    if (rangeType === "today") {
      startDate = getTodayDateStr();
      endDate = startDate;
    } else if (rangeType === "this_week") {
      const w = getThisWeekRange();
      startDate = w.startDate;
      endDate = w.endDate;
    } else if (rangeType === "this_month") {
      const m = getThisMonthRange();
      startDate = m.startDate;
      endDate = m.endDate;
    } else if (isAllRecords) {
      startDate = null;
      endDate = null;
    } else if (!startDate || !endDate) {
      const m = getThisMonthRange();
      startDate = startDate || m.startDate;
      endDate = endDate || m.endDate;
    }

    if (startDate) startDate = formatDateOnly(startDate);
    if (endDate) endDate = formatDateOnly(endDate);

    // 2. Fetch Attendance Records for range
    let attSql = `
      SELECT a.*, a.date::text as date_str
      FROM attendance a
      WHERE a.user_id = $1
    `;
    const attParams = [userId];
    if (startDate && endDate) {
      attParams.push(startDate, endDate);
      attSql += ` AND a.date >= $2 AND a.date <= $3`;
    }
    attSql += ` ORDER BY a.date DESC`;
    const attRes = await query(attSql, attParams);
    const attendanceRecords = attRes.rows;

    // 3. Fetch approved leaves for leave count
    let leaveSql = `
      SELECT * FROM leave_requests
      WHERE user_id = $1 AND status = 'approved'
    `;
    const leaveParams = [userId];
    if (startDate && endDate) {
      leaveParams.push(startDate, endDate);
      leaveSql += ` AND start_date <= $3 AND end_date >= $2`;
    }
    const leaveRes = await query(leaveSql, leaveParams);
    const leaveRecords = leaveRes.rows;

    // 4. Process each day's attendance
    let totalPresentDays = 0;
    let totalLateArrivals = 0;
    let totalAbsentDays = 0;
    let totalLeaveDays = 0;
    let totalNetWorkingMinutes = 0;
    let totalBreakMinutes = 0;

    const shiftStartStr = user.shift_start || "09:00";
    const shiftEndStr = user.shift_end || "18:00";
    const shiftStartMins = parseTimeToMinutes(shiftStartStr) || 540;
    const shiftEndMins = parseTimeToMinutes(shiftEndStr) || 1080;

    const dailyRecords = attendanceRecords.map(a => {
      const dStr = formatDateOnly(a.date_str || a.date);
      const breakCalc = processAttendanceBreaksAndHours(a, user, dStr);

      totalNetWorkingMinutes += breakCalc.netWorkingMinutes;
      totalBreakMinutes += breakCalc.totalBreakMinutes;

      let lateMins = 0;
      let earlyMins = 0;

      const hasApprovedLeave = leaveRecords.some(l => {
        const lStart = formatDateOnly(l.start_date);
        const lEnd = formatDateOnly(l.end_date);
        return dStr >= lStart && dStr <= lEnd;
      });

      let status = a.status || "Present";
      if (hasApprovedLeave || a.status === "on-leave") {
        totalLeaveDays++;
        status = "On Leave";
      } else if (a.check_in) {
        totalPresentDays++;
        const inMins = parseTimeToMinutes(a.check_in);
        if (inMins !== null && inMins > (shiftStartMins + 5)) {
          lateMins = inMins - shiftStartMins;
          totalLateArrivals++;
          status = "Late";
        }
      } else {
        totalAbsentDays++;
        status = "Absent";
      }

      if (a.check_out) {
        const outMins = parseTimeToMinutes(a.check_out);
        if (outMins !== null && outMins < shiftEndMins) {
          earlyMins = shiftEndMins - outMins;
        }
      }

      // Check-in GPS Verification
      let checkInGpsVerification = "GPS unavailable";
      if (a.fence_verified_at || (a.distance_from_office_meters != null && Number(a.distance_from_office_meters) <= allowedRadius)) {
        checkInGpsVerification = "Verified";
      } else if (a.distance_from_office_meters != null && Number(a.distance_from_office_meters) > allowedRadius) {
        checkInGpsVerification = "Outside Boundary";
      } else if (a.check_in_location?.latitude != null && !isNaN(Number(a.check_in_location.latitude))) {
        checkInGpsVerification = "Logged";
      }

      // Check-out GPS Verification
      let checkOutGpsVerification = "GPS unavailable";
      if (a.check_out_location?.latitude != null && !isNaN(Number(a.check_out_location.latitude))) {
        checkOutGpsVerification = "Logged";
      }

      // Late Arrival & Early Departure
      const lateArrival = lateMins > 0 ? `${lateMins}m` : "0m";
      const earlyDeparture = earlyMins > 0 ? `${earlyMins}m` : "0m";

      // Additional breaks beyond 3
      let additionalBreaks = "None";
      if (breakCalc.breaks.length > 3) {
        additionalBreaks = breakCalc.breaks
          .slice(3)
          .map(b => `${b.type}: ${b.startTimeFormatted} - ${b.endTimeFormatted} (${b.durationFormatted})`)
          .join("; ");
      }

      return {
        date: dStr,
        attendanceDate: dStr,
        checkInTime: formatTimeDisplay(a.check_in),
        checkInLocation: breakCalc.checkInLocation,
        checkInGpsVerification,
        break1Start: breakCalc.break1.start,
        break1End: breakCalc.break1.end,
        break1Duration: breakCalc.break1.duration,
        break2Start: breakCalc.break2.start,
        break2End: breakCalc.break2.end,
        break2Duration: breakCalc.break2.duration,
        break3Start: breakCalc.break3.start,
        break3End: breakCalc.break3.end,
        break3Duration: breakCalc.break3.duration,
        additionalBreaks,
        totalBreakDuration: breakCalc.totalBreakDuration,
        checkOutTime: formatTimeDisplay(a.check_out),
        checkOutLocation: breakCalc.checkOutLocation,
        checkOutGpsVerification,
        totalAttendanceDuration: breakCalc.totalAttendanceDuration,
        netWorkingHours: breakCalc.netWorkingHours,
        lateArrival,
        earlyDeparture,
        attendanceStatus: status
      };
    });

    const totalWorkingDays = dailyRecords.length;
    const totalNetH = Math.floor(totalNetWorkingMinutes / 60);
    const totalNetM = totalNetWorkingMinutes % 60;
    const totalNetWorkingHours = `${String(totalNetH).padStart(2, "0")}h ${String(totalNetM).padStart(2, "0")}m`;

    const totalBrkH = Math.floor(totalBreakMinutes / 60);
    const totalBrkM = totalBreakMinutes % 60;
    const totalBreakDuration = `${String(totalBrkH).padStart(2, "0")}h ${String(totalBrkM).padStart(2, "0")}m`;

    const avgMins = totalPresentDays > 0 ? Math.floor(totalNetWorkingMinutes / totalPresentDays) : 0;
    const avgH = Math.floor(avgMins / 60);
    const avgM = avgMins % 60;
    const averageDailyWorkingHours = `${String(avgH).padStart(2, "0")}h ${String(avgM).padStart(2, "0")}m`;

    const summary = {
      totalWorkingDays,
      totalPresentDays,
      totalAbsentDays,
      totalLeaveDays,
      totalLateArrivals,
      totalBreakHours: totalBreakDuration,
      totalBreakDuration,
      totalWorkingHours: totalNetWorkingHours,
      totalNetWorkingHours,
      averageDailyWorkingHours
    };

    const employee = {
      employeeName: user.name,
      employeeId: user.employee_id || `EMP-${user.id.slice(-4).toUpperCase()}`,
      department: user.department || "General",
      designation: user.designation || "Staff"
    };

    if (String(format).toLowerCase() === "csv") {
      const escapeCsv = (val) => {
        if (val == null) return '""';
        const str = String(val).replace(/"/g, '""');
        return `"${str}"`;
      };

      const periodLabel = isAllRecords ? "All Available Records" : `${startDate} to ${endDate}`;

      const csvLines = [
        `"INDIVIDUAL EMPLOYEE ATTENDANCE REPORT"`,
        `"Generated On",${escapeCsv(new Date().toLocaleString())}`,
        `"Reporting Period",${escapeCsv(periodLabel)}`,
        `""`,
        `"EMPLOYEE INFORMATION"`,
        `"Employee Name",${escapeCsv(employee.employeeName)}`,
        `"Employee ID",${escapeCsv(employee.employeeId)}`,
        `"Department",${escapeCsv(employee.department)}`,
        `"Designation",${escapeCsv(employee.designation)}`,
        `""`,
        `"MONTHLY / SELECTED PERIOD SUMMARY"`,
        `"Total Present Days",${summary.totalPresentDays}`,
        `"Total Absent Days",${summary.totalAbsentDays}`,
        `"Total Leave Days",${summary.totalLeaveDays}`,
        `"Total Late Arrivals",${summary.totalLateArrivals}`,
        `"Total Break Hours",${escapeCsv(summary.totalBreakHours)}`,
        `"Total Working Hours",${escapeCsv(summary.totalWorkingHours)}`,
        `"Average Daily Working Hours",${escapeCsv(summary.averageDailyWorkingHours)}`,
        `""`,
        `"DAILY ATTENDANCE DETAILS"`,
        [
          "Attendance Date",
          "Check-in Time",
          "Check-in Location",
          "Check-in GPS Verification",
          "Break 1 Start",
          "Break 1 End",
          "Break 1 Duration",
          "Break 2 Start",
          "Break 2 End",
          "Break 2 Duration",
          "Break 3 Start",
          "Break 3 End",
          "Break 3 Duration",
          "Additional Breaks",
          "Total Break Duration",
          "Check-out Time",
          "Check-out Location",
          "Check-out GPS Verification",
          "Total Attendance Duration",
          "Net Working Hours",
          "Late Arrival",
          "Early Departure",
          "Attendance Status"
        ].map(escapeCsv).join(",")
      ];

      dailyRecords.forEach(r => {
        const row = [
          r.attendanceDate,
          r.checkInTime,
          r.checkInLocation,
          r.checkInGpsVerification,
          r.break1Start,
          r.break1End,
          r.break1Duration,
          r.break2Start,
          r.break2End,
          r.break2Duration,
          r.break3Start,
          r.break3End,
          r.break3Duration,
          r.additionalBreaks,
          r.totalBreakDuration,
          r.checkOutTime,
          r.checkOutLocation,
          r.checkOutGpsVerification,
          r.totalAttendanceDuration,
          r.netWorkingHours,
          r.lateArrival,
          r.earlyDeparture,
          r.attendanceStatus
        ].map(escapeCsv).join(",");
        csvLines.push(row);
      });

      const csvString = csvLines.join("\r\n");
      const safeFilename = `Attendance_Report_${employee.employeeName.replace(/\s+/g, "_")}_${isAllRecords ? "All_Records" : `${startDate}_${endDate}`}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
      return res.send(csvString);
    }

    res.json({
      success: true,
      employee,
      summary,
      records: dailyRecords,
      startDate: startDate || "All",
      endDate: endDate || "All",
      range: rangeType
    });
  } catch (err) {
    console.error("getEmployeeAttendanceReport error:", err);
    res.status(500).json({ error: "Failed to generate employee attendance report." });
  }
};

/**
 * 5. Attendance Analytics & Trends
 * Visual summaries for charts:
 * - Daily attendance percentage
 * - Monthly attendance percentage
 * - Department-wise attendance rates
 * - Late arrival trends
 * - Absence trends
 * - Average working hours
 * - Regularization statistics
 */
export const getAttendanceAnalytics = async (req, res) => {
  try {
    const { isSuperAdmin, targetCompanyId } = resolveTargetCompany(req);
    const { days = 14 } = req.query;
    const numDays = Math.min(Math.max(Number(days) || 14, 7), 60);

    // 1. Fetch total employees count
    let uSql = "SELECT count(*) as count FROM users WHERE role NOT IN ('superadmin', 'client')";
    const uParams = [];
    if (targetCompanyId) {
      uParams.push(targetCompanyId);
      uSql += " AND company_id = $1";
    }
    const uRes = await query(uSql, uParams);
    const totalEmployees = parseInt(uRes.rows[0]?.count || "1", 10) || 1;

    // 2. Fetch past N days attendance records
    const startDateObj = new Date();
    startDateObj.setDate(startDateObj.getDate() - (numDays - 1));
    const startStr = formatDateOnly(startDateObj);
    const endStr = getTodayDateStr();

    let attSql = `
      SELECT a.*, a.date::text as date_str, u.department, u.shift_start
      FROM attendance a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.date >= $1 AND a.date <= $2
    `;
    const attParams = [startStr, endStr];
    if (targetCompanyId) {
      attParams.push(targetCompanyId);
      attSql += ` AND a.company_id = $${attParams.length}`;
    }

    const attRes = await query(attSql, attParams);
    const records = attRes.rows;

    // 3. Generate Day-by-Day Aggregate Array
    const dailyMap = new Map();
    for (let i = 0; i < numDays; i++) {
      const d = new Date(startDateObj);
      d.setDate(d.getDate() + i);
      const dStr = formatDateOnly(d);
      dailyMap.set(dStr, {
        date: dStr,
        displayDate: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        present: 0,
        late: 0,
        absent: 0,
        workingMinutes: 0
      });
    }

    // Department grouping
    const deptMap = new Map();

    records.forEach(r => {
      const dStr = formatDateOnly(r.date_str || r.date);
      const dayItem = dailyMap.get(dStr);
      const dept = r.department || "General";

      if (!deptMap.has(dept)) {
        deptMap.set(dept, { department: dept, present: 0, late: 0, absent: 0, totalHours: 0, recordsCount: 0 });
      }
      const deptItem = deptMap.get(dept);

      if (r.check_in && r.status !== "absent" && !r.is_admin_locked) {
        if (dayItem) {
          dayItem.present++;
          dayItem.workingMinutes += Number(r.duration_minutes) || 0;
        }
        deptItem.present++;
        deptItem.recordsCount++;
        deptItem.totalHours += (Number(r.duration_minutes) || 0) / 60;

        const shiftStartMins = parseTimeToMinutes(r.shift_start || "09:00") || 540;
        const inMins = parseTimeToMinutes(r.check_in);
        if (inMins !== null && inMins > (shiftStartMins + 5)) {
          if (dayItem) dayItem.late++;
          deptItem.late++;
        }
      } else {
        if (dayItem) dayItem.absent++;
        deptItem.absent++;
      }
    });

    const dailyAttendance = Array.from(dailyMap.values()).map(d => {
      const rate = Math.min(100, Math.round((d.present / totalEmployees) * 100));
      const avgHours = d.present > 0 ? (d.workingMinutes / d.present / 60).toFixed(1) : 0;
      return {
        ...d,
        attendanceRate: rate,
        avgHours: Number(avgHours)
      };
    });

    const departmentBreakdown = Array.from(deptMap.values()).map(dept => {
      const rate = dept.recordsCount > 0 ? Math.round((dept.present / dept.recordsCount) * 100) : 0;
      return {
        department: dept.department,
        present: dept.present,
        late: dept.late,
        absent: dept.absent,
        attendanceRate: rate,
        avgHours: dept.present > 0 ? Number((dept.totalHours / dept.present).toFixed(1)) : 0
      };
    });

    // Regularization Stats
    let regSql = "SELECT status, count(*) as count FROM regularization_requests WHERE 1=1";
    const regParams = [];
    if (targetCompanyId) {
      regParams.push(targetCompanyId);
      regSql += " AND company_id = $1";
    }
    regSql += " GROUP BY status";
    const regRes = await query(regSql, regParams);

    const regStats = { total: 0, approved: 0, rejected: 0, pending: 0 };
    regRes.rows.forEach(r => {
      const st = r.status?.toLowerCase();
      const count = parseInt(r.count, 10);
      regStats.total += count;
      if (st === "approved") regStats.approved = count;
      else if (st === "rejected") regStats.rejected = count;
      else if (st === "pending") regStats.pending = count;
    });

    res.json({
      dailyAttendance,
      departmentBreakdown,
      regularizationStats: regStats,
      totalEmployees
    });
  } catch (err) {
    console.error("getAttendanceAnalytics error:", err);
    res.status(500).json({ error: "Failed to generate attendance analytics." });
  }
};

/**
 * 6. Admin Attendance Record Review / Manual Override
 * Allows administrators to add remarks, unlock attendance, or adjust status with full audit logging.
 */
export const reviewAttendanceRecord = async (req, res) => {
  try {
    const { id } = req.params;
    const { adminNotes, status, unlock, userId, date } = req.body;
    const reviewerId = req.user?.id;
    const { isSuperAdmin, targetCompanyId } = resolveTargetCompany(req);

    if (!id) {
      return res.status(400).json({ error: "Attendance record ID is required." });
    }

    let targetId = id;
    let targetUserId = userId;
    let targetDate = date;

    if (id.startsWith("sim_")) {
      const parts = id.replace("sim_", "").split("_");
      targetDate = parts.pop();
      targetUserId = parts.join("_");
      targetId = `${targetUserId}_${targetDate}`;
    }

    // Check if record exists
    const checkRes = await query("SELECT * FROM attendance WHERE id = $1", [targetId]);
    if (checkRes.rows.length === 0) {
      if (!targetUserId || !targetDate) {
        return res.status(404).json({ error: "Attendance record not found." });
      }
      const newStatus = status || "absent";
      const insertRes = await query(
        `INSERT INTO attendance (id, user_id, company_id, date, status, admin_notes, admin_modified_by, admin_modified_at, is_admin_locked)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, $8)
         RETURNING *`,
        [targetId, targetUserId, targetCompanyId, targetDate, newStatus, adminNotes || null, reviewerId, unlock ? false : false]
      );

      auditService.logAudit({
        userId: reviewerId,
        action: "ATTENDANCE_RECORD_REVIEWED",
        resourceType: "attendance",
        resourceId: targetId,
        details: {
          employeeId: targetUserId,
          date: targetDate,
          adminNotes,
          status: newStatus,
          created: true
        },
        req
      });

      return res.json({
        success: true,
        record: insertRes.rows[0],
        message: "Attendance record updated successfully."
      });
    }

    const updates = ["admin_modified_by = $1", "admin_modified_at = CURRENT_TIMESTAMP"];
    const params = [reviewerId];

    if (adminNotes !== undefined) {
      params.push(adminNotes);
      updates.push(`admin_notes = $${params.length}`);
    }

    if (unlock) {
      params.push(false);
      updates.push(`is_admin_locked = $${params.length}`);
      params.push(false);
      updates.push(`is_system_penalized = $${params.length}`);
      params.push(null);
      updates.push(`penalty_status = $${params.length}`);
      params.push(null);
      updates.push(`absence_reason = $${params.length}`);
    }

    if (status) {
      params.push(status);
      updates.push(`status = $${params.length}`);
    }

    params.push(targetId);
    let sql = `UPDATE attendance SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = $${params.length}`;
    if (!isSuperAdmin && targetCompanyId) {
      params.push(targetCompanyId);
      sql += ` AND company_id = $${params.length}`;
    }
    sql += " RETURNING *";

    const result = await query(sql, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Attendance record not found or access denied." });
    }

    const updated = result.rows[0];

    // Audit Log
    auditService.logAudit({
      userId: reviewerId,
      action: "ATTENDANCE_RECORD_REVIEWED",
      resourceType: "attendance",
      resourceId: targetId,
      details: {
        employeeId: updated.user_id,
        date: updated.date,
        adminNotes,
        status,
        unlocked: Boolean(unlock)
      },
      req
    });

    res.json({
      success: true,
      record: updated,
      message: "Attendance record updated successfully."
    });
  } catch (err) {
    console.error("reviewAttendanceRecord error:", err);
    res.status(500).json({ error: "Failed to review attendance record." });
  }
};
