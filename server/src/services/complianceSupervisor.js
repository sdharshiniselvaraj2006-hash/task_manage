import { query } from "../config/db.js";
import { sendNotificationOnce } from "./notificationService.js";

/**
 * Compliance Supervisor Service
 * -------------------------------------------------------------
 * Automatically enforces:
 * 1. 1-Hour Task View / Acknowledge SLA -> Auto-marks attendance as Absent (locked)
 * 2. 1-Hour Progress Report Reminder -> Sends notification to employee
 * 3. 2-Hour Continuous Hourly Reporting SLA -> Auto-marks attendance as Absent (locked)
 */

export const getCompanyTimezone = async (companyId) => {
  if (!companyId) return "Asia/Kolkata";
  try {
    const res = await query("SELECT settings FROM companies WHERE id = $1", [companyId]);
    const settings = res.rows[0]?.settings;
    if (settings && typeof settings === "object" && settings.timezone) {
      return settings.timezone;
    }
    return "Asia/Kolkata";
  } catch {
    return "Asia/Kolkata";
  }
};

export const getLocalDateInTz = (timeZone = "Asia/Kolkata") => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  } catch {
    return new Date().toISOString().split("T")[0];
  }
};

let isCheckingCompliance = false;

export const checkComplianceNow = async (io = null, targetCompanyId = null) => {
  let attempts = 0;
  while (isCheckingCompliance && attempts < 30) {
    await new Promise(r => setTimeout(r, 200));
    attempts++;
  }
  isCheckingCompliance = true;
  try {
    const taskPenalties = await runTaskUnseenComplianceCheck(io, targetCompanyId);
    const { remindersCount, penaltyCount } = await runHourlyReportingComplianceCheck(io, targetCompanyId);
    return { taskPenalties, remindersCount, penaltyCount };
  } finally {
    isCheckingCompliance = false;
  }
};

/**
 * 1. Check for tasks assigned to employees not viewed/acknowledged within 10 minutes
 * (Attendance absent marking is NOT applied for unviewed tasks; only unsubmitted reports after 10m mark absent)
 */
export const runTaskUnseenComplianceCheck = async (io = null, targetCompanyId = null) => {
  // Absent-marking and account-locking penalties removed for unviewed tasks per user specification.
  // Absent penalties are ONLY applied when progress reports are not submitted 10 minutes after due.
  return 0;
};

/**
 * 2. Check for checked-in employees and active task assignees for:
 *    - 5-minute progress report reminder (every 5 minutes)
 *    - 10-minute missed report penalty -> Auto-marks attendance as Absent (locked)
 */
export const runHourlyReportingComplianceCheck = async (io = null, targetCompanyId = null) => {
  try {
    let penaltyCount = 0;
    let remindersCount = 0;
    const penalizedUsers = new Set();
    const remindedUsers = new Set();

    // 1. Check employees with active assigned tasks
    let taskSql = `
      SELECT t.id as task_id, t.title as task_title, t.company_id, t.assigned_to, t.viewed_at, t.assigned_at, t.created_at, t.last_reported_at, t.deadline, t.metadata, t.sla_penalty_applied,
             u.name as employee_name, u.email as employee_email,
             c.settings as company_settings
      FROM tasks t
      JOIN users u ON t.assigned_to = u.id
      LEFT JOIN companies c ON t.company_id = c.id
      WHERE t.status NOT IN ('completed', 'cancelled', 'suspended')
        AND t.assigned_to IS NOT NULL
        AND (
          (t.sla_penalty_applied IS FALSE OR t.sla_penalty_applied IS NULL)
          OR EXISTS (
            SELECT 1 FROM attendance a 
            WHERE a.user_id = t.assigned_to 
              AND a.date >= (CURRENT_DATE - INTERVAL '1 day')
              AND a.check_in IS NOT NULL 
              AND a.check_out IS NULL
          )
        )
    `;
    const taskParams = [];
    if (targetCompanyId) {
      taskParams.push(targetCompanyId);
      taskSql += ` AND t.company_id = $${taskParams.length}`;
    }

    const activeTasksRes = await query(taskSql, taskParams);

    for (const task of activeTasksRes.rows) {
      const tz = await getCompanyTimezone(task.company_id);
      const today = getLocalDateInTz(tz);

      // Find latest report for this employee & task today (isolated strictly per task)
      const repRes = await query(
        `SELECT created_at FROM hourly_reports 
         WHERE user_id = $1 AND task_id = $2 AND report_date = $3
         ORDER BY created_at DESC LIMIT 1`,
        [task.assigned_to, task.task_id, today]
      );

      // If task deadline is already passed and has expired, reporting is locked on deadline grounds
      const rawMeta = task.metadata;
      const meta = (rawMeta && typeof rawMeta === 'object') ? rawMeta : (typeof rawMeta === 'string' ? JSON.parse(rawMeta || '{}') : {});
      if (meta.deadlineNotified || task.deadline_notified) {
        continue;
      }
      const candidateDeadlines = [
        task.deadline ? new Date(task.deadline).getTime() : 0,
        meta.deadlineTimestamp ? new Date(meta.deadlineTimestamp).getTime() : 0
      ].filter(ts => ts > 0 && !isNaN(ts));
      const exactDeadline = candidateDeadlines.length > 0 ? new Date(Math.max(...candidateDeadlines)) : null;
      if (exactDeadline && !isNaN(exactDeadline.getTime())) {
        if (Date.now() > exactDeadline.getTime()) {
          // Task deadline has completed; mark metadata so it never notifies again
          const updatedMeta = { ...meta, deadlineNotified: true, deadlineNotifiedAt: new Date().toISOString() };
          await query(
            `UPDATE tasks SET metadata = $1, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(updatedMeta), task.task_id]
          ).catch(() => {});

          // Send exactly one notification and skip hourly report penalties
          await sendNotificationOnce({
            userId: task.assigned_to,
            title: `Task Deadline Completed: ${task.task_title}`,
            message: `The deadline for task "${task.task_title}" has completed. Action on this task is concluded.`,
            type: "warning",
            link: "/task-management",
            io,
            activityType: "task_deadline_completed",
            entityId: task.task_id,
            taskTitle: task.task_title
          });
          continue;
        }
      }

      const repTime = repRes.rows.length > 0
        ? new Date(repRes.rows[0].created_at).getTime()
        : 0;
      const lastReportedTime = task.last_reported_at
        ? new Date(task.last_reported_at).getTime()
        : 0;
      const unlockTime = meta.unlockedAt
        ? new Date(meta.unlockedAt).getTime()
        : 0;

      const latestReportMs = Math.max(repTime, lastReportedTime, unlockTime);

      const baselineTime = latestReportMs > 0
        ? latestReportMs
        : new Date(task.assigned_at || task.created_at).getTime();

      const elapsedMinutes = Math.floor((Date.now() - baselineTime) / (60 * 1000));

      // Rule 1: Progress reminder when report is approaching due (3 to 4 minutes without report)
      if (elapsedMinutes >= 3 && elapsedMinutes < 5 && !remindedUsers.has(task.assigned_to)) {
        const notifResult = await sendNotificationOnce({
          userId: task.assigned_to,
          title: `Task Progress Report Due: ${task.task_title}`,
          message: `Your progress report on task "${task.task_title}" is due. Please submit your progress report within 5 minutes to prevent attendance being marked Absent.`,
          type: "warning",
          link: "/task-management",
          io,
          activityType: "report_reminder",
          entityId: task.task_id,
          taskTitle: task.task_title
        });

        if (notifResult && !notifResult.duplicate) {
          remindersCount++;
        }
        remindedUsers.add(task.assigned_to);
      }

      // Rule 2: 5-Minute Overdue Report Violation -> Mark Absent & Lock Task
      // Rule 3: 10-Minute Overdue Report Violation -> Automatically Check Out Shift
      if (elapsedMinutes >= 5) {
        // 1. Immediately apply SLA penalty on the task if not already applied
        if (!task.sla_penalty_applied) {
          await query(
            `UPDATE tasks SET sla_penalty_applied = TRUE, updated_at = NOW() WHERE id = $1`,
            [task.task_id]
          ).catch(() => {});

          if (io) {
            io.to(`user_${task.assigned_to}`).emit("task_updated", { id: task.task_id, sla_penalty_applied: true });
            io.emit("task_updated", { id: task.task_id, sla_penalty_applied: true });
          }
        }

        // At 10 minutes without report: auto check out the attendance session
        const shouldAutoCheckOut = elapsedMinutes >= 10;

        // 2. Fetch employee attendance for today
        const attRes = await query(
          `SELECT id, status, is_admin_locked, penalty_status, check_in, check_out, breaks, sessions, accumulated_working_minutes, duration_minutes, auto_checked_out
           FROM attendance 
           WHERE user_id = $1 AND date = $2
           ORDER BY check_in DESC NULLS LAST, created_at DESC LIMIT 1`,
          [task.assigned_to, today]
        );

        let attRecord = attRes.rows[0];
        const penaltyReason = shouldAutoCheckOut
          ? `Missed required progress report on task "${task.task_title}" for > 10 minutes. Automatically checked out.`
          : `Missed required progress report on task "${task.task_title}" for > 5 minutes.`;
        let attId = attRecord?.id || `${task.assigned_to}_${today}`;
        const now = new Date();
        const nowIso = now.toISOString();

        let totalDayMins = 0;
        let finalSessions = [];
        let finalCheckout = shouldAutoCheckOut ? nowIso : (attRecord?.check_out || null);

        if (attRecord) {
          penaltyCount++;

          let breaks = Array.isArray(attRecord.breaks) ? [...attRecord.breaks] : [];
          let totalBreakMinutes = 0;
          breaks.forEach(b => {
            if (b.start && b.end) {
              totalBreakMinutes += Math.max(0, Math.floor((new Date(b.end) - new Date(b.start)) / 60000));
            } else if (b.start && !b.end) {
              if (shouldAutoCheckOut) {
                b.end = nowIso;
                const dur = Math.max(0, Math.floor((now.getTime() - new Date(b.start).getTime()) / 60000));
                b.durationMinutes = dur;
                totalBreakMinutes += dur;
              }
            }
          });

          let rawSessions = Array.isArray(attRecord.sessions) ? [...attRecord.sessions] : [];
          const cleanSessions = [];
          const seenCheckIns = new Set();
          let computedTotalDayMins = 0;

          rawSessions.forEach((s, idx) => {
            if (!s || !s.checkIn) return;
            const inMs = new Date(s.checkIn).getTime();
            const key = Math.floor(inMs / 10000);
            if (seenCheckIns.has(key)) return;
            seenCheckIns.add(key);

            let cOut = s.checkOut;
            let dur = Number(s.durationMinutes) || 0;
            if (!cOut) {
              if (shouldAutoCheckOut) {
                cOut = nowIso;
                dur = Math.max(1, Math.floor((now.getTime() - inMs) / 60000) - totalBreakMinutes);
              }
            } else if (dur <= 0 && s.checkOut) {
              dur = Math.max(1, Math.floor((new Date(s.checkOut).getTime() - inMs) / 60000));
            }
            cleanSessions.push({
              ...s,
              checkOut: cOut,
              durationMinutes: dur
            });
            if (cOut) {
              computedTotalDayMins += dur;
            }
          });

          // If cleanSessions had no sessions but check_in exists, record it
          if (cleanSessions.length === 0 && attRecord.check_in) {
            const inDate = new Date(attRecord.check_in);
            const inMs = inDate.getTime();
            let dur = Math.max(1, Math.floor((now.getTime() - inMs) / 60000) - totalBreakMinutes);
            if (dur >= 1440) {
              const inMinsOfDay = inDate.getHours() * 60 + inDate.getMinutes();
              const outMinsOfDay = now.getHours() * 60 + now.getMinutes();
              const sameDayMins = outMinsOfDay >= inMinsOfDay ? (outMinsOfDay - inMinsOfDay) : (1440 - inMinsOfDay + outMinsOfDay);
              dur = Math.min(1440, Math.max(1, sameDayMins - totalBreakMinutes));
            }
            cleanSessions.push({
              sessionId: `sess_${inMs}_1`,
              checkIn: new Date(attRecord.check_in).toISOString(),
              checkOut: shouldAutoCheckOut ? nowIso : (attRecord.check_out || null),
              durationMinutes: dur,
              breaks
            });
            if (shouldAutoCheckOut || attRecord.check_out) {
              computedTotalDayMins = dur;
            }
          }

          totalDayMins = Math.min(1440, computedTotalDayMins || attRecord.duration_minutes || 0);
          finalSessions = cleanSessions;
          finalCheckout = shouldAutoCheckOut ? (attRecord.check_out || nowIso) : (attRecord.check_out || null);

          if (shouldAutoCheckOut) {
            await query(
              `UPDATE attendance
               SET status = 'absent',
                   check_out = COALESCE(check_out, $1),
                   auto_checked_out = TRUE,
                   penalty_status = COALESCE(penalty_status, 'missed_hourly_report_penalty'),
                   is_admin_locked = TRUE,
                   penalty_applied_at = COALESCE(penalty_applied_at, NOW()),
                   penalty_reason = $2,
                   penalized_by_task_id = COALESCE(penalized_by_task_id, $3),
                   duration_minutes = $4,
                   accumulated_working_minutes = $4,
                   sessions = $5,
                   breaks = $6,
                   updated_at = NOW()
               WHERE id = $7`,
              [finalCheckout, penaltyReason, task.task_id, totalDayMins, JSON.stringify(finalSessions), JSON.stringify(breaks), attId]
            );
          } else {
            // At 5 minutes: Mark absent & lock, but do not check-out until 10 minutes
            await query(
              `UPDATE attendance
               SET status = 'absent',
                   penalty_status = COALESCE(penalty_status, 'missed_hourly_report_penalty'),
                   is_admin_locked = TRUE,
                   penalty_applied_at = COALESCE(penalty_applied_at, NOW()),
                   penalty_reason = $1,
                   penalized_by_task_id = COALESCE(penalized_by_task_id, $2),
                   updated_at = NOW()
               WHERE id = $3`,
              [penaltyReason, task.task_id, attId]
            );
          }

          // Clean up any extra duplicate rows for this user on this day
          await query(
            `DELETE FROM attendance WHERE user_id = $1 AND date = $2 AND id != $3`,
            [task.assigned_to, today, attId]
          ).catch(() => {});
        } else {
          penaltyCount++;
          attId = `${task.assigned_to}_${today}`;
          if (shouldAutoCheckOut) {
            await query(
              `INSERT INTO attendance (
                id, user_id, company_id, date, status, check_out, auto_checked_out, penalty_status,
                is_admin_locked, penalty_applied_at, penalty_reason, penalized_by_task_id,
                duration_minutes, accumulated_working_minutes, sessions, breaks,
                created_at, updated_at
              )
              VALUES ($1, $2, $3, $4, 'absent', NOW(), TRUE, 'missed_hourly_report_penalty', TRUE, NOW(), $5, $6, 0, 0, '[]'::jsonb, '[]'::jsonb, NOW(), NOW())
              ON CONFLICT (id) DO UPDATE SET
                status = 'absent',
                check_out = COALESCE(attendance.check_out, NOW()),
                auto_checked_out = TRUE,
                penalty_status = 'missed_hourly_report_penalty',
                is_admin_locked = TRUE,
                penalty_applied_at = NOW(),
                penalty_reason = EXCLUDED.penalty_reason,
                penalized_by_task_id = EXCLUDED.penalized_by_task_id,
                updated_at = NOW()`,
              [attId, task.assigned_to, task.company_id, today, penaltyReason, task.task_id]
            );
          } else {
            await query(
              `INSERT INTO attendance (
                id, user_id, company_id, date, status, penalty_status,
                is_admin_locked, penalty_applied_at, penalty_reason, penalized_by_task_id,
                duration_minutes, accumulated_working_minutes, sessions, breaks,
                created_at, updated_at
              )
              VALUES ($1, $2, $3, $4, 'absent', 'missed_hourly_report_penalty', TRUE, NOW(), $5, $6, 0, 0, '[]'::jsonb, '[]'::jsonb, NOW(), NOW())
              ON CONFLICT (id) DO UPDATE SET
                status = 'absent',
                penalty_status = 'missed_hourly_report_penalty',
                is_admin_locked = TRUE,
                penalty_applied_at = NOW(),
                penalty_reason = EXCLUDED.penalty_reason,
                penalized_by_task_id = EXCLUDED.penalized_by_task_id,
                updated_at = NOW()`,
              [attId, task.assigned_to, task.company_id, today, penaltyReason, task.task_id]
            );
          }
        }

        const notifKey = shouldAutoCheckOut ? `auto_checkout_${task.assigned_to}` : `absent_${task.assigned_to}`;
        if (!penalizedUsers.has(notifKey)) {
          penalizedUsers.add(notifKey);

          const notifTitle = shouldAutoCheckOut
            ? "Attendance Automatically Checked Out (Absent)"
            : "Attendance Marked Absent (Report Overdue)";
          const notifMsg = shouldAutoCheckOut
            ? `You did not submit a progress report on task "${task.task_title}" for > 10 minutes. Your attendance has been marked Absent and automatically checked out.`
            : `You did not submit the required progress report on task "${task.task_title}" within 5 minutes. Your attendance has been marked Absent and reporting locked. If unsubmitted for 10 minutes, you will be automatically checked out.`;

          await sendNotificationOnce({
            userId: task.assigned_to,
            title: notifTitle,
            message: notifMsg,
            type: "error",
            link: "/task-management",
            io,
            activityType: shouldAutoCheckOut ? "auto_checkout_penalty" : "absent_penalty",
            entityId: `${task.task_id}_${shouldAutoCheckOut ? "checkout" : "absent"}`
          });

          // Notification to Company Admins
          if (task.company_id) {
            const adminsRes = await query(
              `SELECT id FROM users WHERE company_id = $1 AND role IN ('admin', 'superadmin')`,
              [task.company_id]
            );

            for (const admin of adminsRes.rows) {
              await sendNotificationOnce({
                userId: admin.id,
                title: shouldAutoCheckOut
                  ? "Missed Task Report: Employee Auto Checked Out (Absent)"
                  : "Missed Task Report: Attendance Marked Absent",
                message: shouldAutoCheckOut
                  ? `${task.employee_name || "Employee"} did not report on task "${task.task_title}" for > 10 minutes. Attendance marked Absent and automatically checked out.`
                  : `${task.employee_name || "Employee"} did not report on task "${task.task_title}" within 5 minutes. Attendance marked Absent and task locked.`,
                type: "warning",
                link: "/task-management",
                io,
                activityType: shouldAutoCheckOut ? "admin_checkout_alert" : "admin_absent_alert",
                entityId: `${task.assigned_to}_${task.task_id}_${shouldAutoCheckOut ? "checkout" : "absent"}`
              });
            }
          }

          // Socket.IO Real-Time Broadcast
          if (io) {
            const payload = {
              attendanceId: attId,
              userId: task.assigned_to,
              companyId: task.company_id,
              employeeName: task.employee_name,
              status: "absent",
              is_admin_locked: true,
              isAttendanceLocked: true,
              auto_checked_out: shouldAutoCheckOut,
              check_out: shouldAutoCheckOut ? finalCheckout : attRecord?.check_out || null,
              checkOutTime: shouldAutoCheckOut ? finalCheckout : attRecord?.check_out || null,
              check_in: attRecord?.check_in || null,
              checkInTime: attRecord?.check_in || null,
              sessions: finalSessions,
              totalWorkingMinutes: totalDayMins,
              durationMinutes: totalDayMins,
              duration_minutes: totalDayMins,
              accumulated_working_minutes: totalDayMins,
              accumulatedWorkingMinutes: totalDayMins,
              penaltyType: "missed_hourly_report_penalty",
              penalty_status: "missed_hourly_report_penalty",
              penaltyReason,
              taskId: task.task_id,
              taskTitle: task.task_title,
              elapsedMinutes
            };
            io.to(`user_${task.assigned_to}`).emit("attendance_penalty_applied", payload);
            io.to(`user_${task.assigned_to}`).emit("attendance_updated", payload);
            if (task.company_id) {
              io.to(`company_${task.company_id}`).emit("attendance_penalty_applied", payload);
              io.to(`company_${task.company_id}`).emit("attendance_updated", payload);
            }
            io.emit("attendance_penalty_applied", payload);
            io.emit("attendance_updated", payload);
          }
        }
      }
    }

    // 2. Also check general active check-ins (only for employees without assigned tasks)
    let sql = `
      SELECT a.id as attendance_id, a.user_id, a.company_id, a.check_in, a.date, a.updated_at,
             u.name as employee_name, u.email as employee_email,
             c.settings as company_settings
      FROM attendance a
      JOIN users u ON a.user_id = u.id
      LEFT JOIN companies c ON a.company_id = c.id
      WHERE a.date >= (CURRENT_DATE - INTERVAL '1 day')
        AND a.check_in IS NOT NULL
        AND a.check_out IS NULL
        AND a.status = 'present'
        AND (a.is_admin_locked IS FALSE OR a.is_admin_locked IS NULL)
    `;
    const params = [];
    if (targetCompanyId) {
      params.push(targetCompanyId);
      sql += ` AND a.company_id = $${params.length}`;
    }

    const activeAtt = await query(sql, params);

    for (const record of activeAtt.rows) {
      if (penalizedUsers.has(record.user_id)) continue;

      // An employee's progress reporting is governed STRICTLY per assigned task in Section 1 above.
      // If employee has active tasks, Section 1 already handled them; skip here to avoid shift-duration false penalties!
      const activeTasksCheck = await query(
        `SELECT id FROM tasks 
         WHERE assigned_to = $1 
           AND status NOT IN ('completed', 'cancelled', 'suspended')
         LIMIT 1`,
        [record.user_id]
      );

      if (activeTasksCheck.rows.length > 0) {
        continue;
      }

      // If employee has NO active tasks -> no task progress reporting required -> skip completely!
      continue;
    }

    return { remindersCount, penaltyCount };
  } catch (err) {
    console.error("❌ [ComplianceSupervisor] runHourlyReportingComplianceCheck error:", err);
    return { remindersCount: 0, penaltyCount: 0 };
  }
};

/**
 * Start the background compliance supervisor daemon
 */
export const startComplianceSupervisor = (io, intervalMs = 60000) => {
  console.log("🛡️ [ComplianceSupervisor] Task & Progress Reporting SLA Supervisor started (60s tick).");

  // Initial immediate check
  setTimeout(() => {
    checkComplianceNow(io).catch(() => {});
  }, 3000);

  // Periodic recurring check
  const intervalId = setInterval(() => {
    checkComplianceNow(io).catch(err => {
      console.error("❌ [ComplianceSupervisor] Tick error:", err);
    });
  }, intervalMs);

  return intervalId;
};
