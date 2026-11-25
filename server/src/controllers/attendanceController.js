import crypto from "crypto";
import { query } from "../config/db.js";
import auditService from "../services/auditService.js";
import securityDetector from "../services/securityDetector.js";
import faceServiceClient, {
  FaceServiceUnavailableError,
  FaceServiceVerificationError
} from "../services/faceServiceClient.js";
import { isValidEmbedding, evaluateFaceMatch } from "../services/faceVerificationPolicy.js";
import { validateEnrollmentPayload, canEnrollFace } from "../services/faceEnrollmentValidation.js";
import { generateVerificationSessionToken, hashToken } from "../services/livenessVerification.js";
import { validateServerGeofence } from "../utils/geofence.js";
import { withTransaction } from "../utils/transaction.js";
import { sendNotificationOnce } from "../services/notificationService.js";

const FACE_REENROLL_VALIDITY_HOURS = Number(process.env.FACE_REENROLL_VALIDITY_HOURS || 24);

const isAdminRole = (user) => {
  const role = String(user?.role || "").toLowerCase();
  return ["admin", "superadmin", "system admin", "hr manager"].includes(role);
};

const getActiveFaceReenrollmentPermission = async (employeeId, companyId) => {
  await ensureFaceReenrollmentTable();
  const result = await query(
    `SELECT *
     FROM face_reenrollment_requests
     WHERE employee_id = $1
       AND company_id = $2
       AND status = 'approved'
       AND permission_expires_at IS NOT NULL
       AND permission_expires_at > NOW()
       AND used_at IS NULL
     ORDER BY requested_at DESC
     LIMIT 1`,
    [employeeId, companyId]
  );
  return result.rows[0] || null;
};

export const getFaceReenrollmentPermission = async (employeeId, companyId) => {
  if (!employeeId || !companyId) return null;
  return getActiveFaceReenrollmentPermission(employeeId, companyId);
};

export const validateFaceReenrollmentPermission = async (employeeId, companyId) => {
  if (!employeeId || !companyId) return null;
  return getActiveFaceReenrollmentPermission(employeeId, companyId);
};

export const requestFaceReenrollment = async (req, res) => {
  try {
    await ensureFaceReenrollmentTable();
    const reason = String(req.body?.reason || "").trim();
    if (!reason) {
      return res.status(400).json({ error: "A brief reason is required before requesting face re-enrollment." });
    }

    const userId = req.user?.id;
    const companyId = req.user?.companyId;

    if (!userId || !companyId) {
      return res.status(401).json({ error: "Authenticated session required." });
    }

    const existingProfile = await query(
      `SELECT * FROM employee_face_profiles WHERE user_id = $1 AND company_id = $2`,
      [userId, companyId]
    );

    if (existingProfile.rows.length === 0 || existingProfile.rows[0].enrollment_status !== "enrolled") {
      return res.status(400).json({ error: "Face re-enrollment can only be requested after a face has already been enrolled." });
    }

    const pendingCheck = await query(
      `SELECT *
       FROM face_reenrollment_requests
       WHERE employee_id = $1
         AND company_id = $2
         AND status = 'pending'
       ORDER BY requested_at DESC
       LIMIT 1`,
      [userId, companyId]
    );

    if (pendingCheck.rows.length > 0) {
      return res.status(409).json({
        error: "A face re-enrollment request is already pending approval.",
        request: pendingCheck.rows[0]
      });
    }

    const activeApproved = await getActiveFaceReenrollmentPermission(userId, companyId);
    if (activeApproved) {
      return res.status(409).json({
        error: "You already have an active approved face re-enrollment permission.",
        request: activeApproved
      });
    }

    const requestId = `face_reenroll_${crypto.randomUUID()}`;
    const result = await query(
      `INSERT INTO face_reenrollment_requests (id, employee_id, company_id, reason, status, requested_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW(), NOW(), NOW())
       RETURNING *`,
      [requestId, userId, companyId, reason]
    );

    await query(
      `UPDATE employee_face_profiles
       SET reenrollment_requested_at = NOW(),
           reenrollment_reason = $2,
           metadata = COALESCE(metadata, '{}'::jsonb) || '{"reenrollmentRequested": true}'::jsonb,
           updated_at = NOW()
       WHERE user_id = $1 AND company_id = $3`,
      [userId, reason, companyId]
    );

    auditService.logAudit({
      userId,
      action: "FACE_REENROLLMENT_REQUESTED",
      resourceType: "biometrics",
      resourceId: requestId,
      details: { reason, companyId },
      req
    });

    res.json({ success: true, request: result.rows[0] });
  } catch (err) {
    console.error("requestFaceReenrollment error:", err);
    res.status(500).json({ error: "Failed to submit face re-enrollment request." });
  }
};

export const getMyFaceReenrollmentRequest = async (req, res) => {
  try {
    const userId = req.user?.id;
    const companyId = req.user?.companyId;

    if (!userId || !companyId) {
      return res.status(401).json({ error: "Authenticated session required." });
    }

    const result = await query(
      `SELECT *
       FROM face_reenrollment_requests
       WHERE employee_id = $1 AND company_id = $2
       ORDER BY requested_at DESC
       LIMIT 1`,
      [userId, companyId]
    );

    res.json({ request: result.rows[0] || null });
  } catch (err) {
    console.error("getMyFaceReenrollmentRequest error:", err);
    res.status(500).json({ error: "Failed to load your face re-enrollment request." });
  }
};

export const getFaceReenrollmentRequests = async (req, res) => {
  try {
    const role = (req.user?.role || "").toLowerCase();
    const isSuperAdmin = role === "superadmin";
    const isAdmin = role === "admin" || role === "hr manager" || role === "system admin";

    if (!isAdmin && !isSuperAdmin) {
      return res.status(403).json({ error: "Access denied. Admin role required." });
    }

    const status = String(req.query.status || "pending").trim().toLowerCase();
    const companyId = req.user.companyId;

    let sql = `
      SELECT r.*, u.name as employee_name, u.email as employee_email
      FROM face_reenrollment_requests r
      LEFT JOIN users u ON u.id = r.employee_id
      WHERE 1 = 1
    `;
    const params = [];

    if (!isSuperAdmin && companyId) {
      params.push(companyId);
      sql += ` AND r.company_id = $${params.length}`;
    }

    if (status && status !== "all") {
      params.push(status);
      sql += ` AND r.status = $${params.length}`;
    }

    sql += ` ORDER BY r.requested_at DESC`;

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error("getFaceReenrollmentRequests error:", err);
    res.status(500).json({ error: "Failed to load face re-enrollment requests." });
  }
};

export const approveFaceReenrollmentRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const role = (req.user?.role || "").toLowerCase();
    const isSuperAdmin = role === "superadmin";
    const isAdmin = role === "admin" || role === "hr manager" || role === "system admin";

    if (!isAdmin && !isSuperAdmin) {
      return res.status(403).json({ error: "Access denied. Admin role required." });
    }

    const result = await query(
      `UPDATE face_reenrollment_requests
       SET status = 'approved',
           reviewed_by = $1,
           reviewed_at = NOW(),
           rejection_reason = NULL,
           permission_expires_at = NOW() + INTERVAL '${FACE_REENROLL_VALIDITY_HOURS} hours',
           updated_at = NOW()
       WHERE id = $2 ${!isSuperAdmin ? "AND company_id = $3" : ""}
       RETURNING *`,
      !isSuperAdmin ? [req.user.id, id, req.user.companyId] : [req.user.id, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Face re-enrollment request not found." });
    }

    const request = result.rows[0];
    await query(
      `UPDATE employee_face_profiles
       SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"selfEnrollmentAuthorized": true, "reenrollmentAuthorized": true, "reenrollmentApprovedAt": "' || NOW()::text || '", "reenrollmentApprovedBy": "' || $1 || '"}'::jsonb,
           updated_at = NOW()
       WHERE user_id = $2 AND company_id = $3`,
      [req.user.id, request.employee_id, request.company_id]
    );

    await addNotification({
      userId: request.employee_id,
      title: "Face Re-enrollment Approved",
      message: "Your administrator approved your face re-enrollment request. You can now capture a new reference template.",
      type: "success",
      link: "/face-enrollment"
    });

    auditService.logAudit({
      userId: req.user.id,
      action: "FACE_REENROLLMENT_APPROVED",
      resourceType: "biometrics",
      resourceId: request.id,
      details: { employeeId: request.employee_id, companyId: request.company_id },
      req
    });

    res.json({ success: true, request });
  } catch (err) {
    console.error("approveFaceReenrollmentRequest error:", err);
    res.status(500).json({ error: "Failed to approve face re-enrollment request." });
  }
};

export const rejectFaceReenrollmentRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { rejectionReason } = req.body || {};
    const role = (req.user?.role || "").toLowerCase();
    const isSuperAdmin = role === "superadmin";
    const isAdmin = role === "admin" || role === "hr manager" || role === "system admin";

    if (!isAdmin && !isSuperAdmin) {
      return res.status(403).json({ error: "Access denied. Admin role required." });
    }

    const result = await query(
      `UPDATE face_reenrollment_requests
       SET status = 'rejected',
           reviewed_by = $1,
           reviewed_at = NOW(),
           rejection_reason = $2,
           permission_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $3 ${!isSuperAdmin ? "AND company_id = $4" : ""}
       RETURNING *`,
      !isSuperAdmin ? [req.user.id, rejectionReason || "Not provided", id, req.user.companyId] : [req.user.id, rejectionReason || "Not provided", id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Face re-enrollment request not found." });
    }

    const request = result.rows[0];
    await query(
      `UPDATE employee_face_profiles
       SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"selfEnrollmentAuthorized": false, "reenrollmentAuthorized": false}'::jsonb,
           updated_at = NOW()
       WHERE user_id = $2 AND company_id = $3`,
      [req.user.id, request.employee_id, request.company_id]
    );

    await addNotification({
      userId: request.employee_id,
      title: "Face Re-enrollment Rejected",
      message: rejectionReason ? `Your re-enrollment request was rejected: ${rejectionReason}` : "Your face re-enrollment request was rejected by your administrator.",
      type: "warning",
      link: "/face-enrollment"
    });

    auditService.logAudit({
      userId: req.user.id,
      action: "FACE_REENROLLMENT_REJECTED",
      resourceType: "biometrics",
      resourceId: request.id,
      details: { employeeId: request.employee_id, companyId: request.company_id, rejectionReason },
      req
    });

    res.json({ success: true, request });
  } catch (err) {
    console.error("rejectFaceReenrollmentRequest error:", err);
    res.status(500).json({ error: "Failed to reject face re-enrollment request." });
  }
};

export const getVerificationAttempts = async (req, res) => {
  try {
    const role = (req.user?.role || "").toLowerCase();
    const isSuperAdmin = role === "superadmin";
    const isAdmin = role === "admin" || role === "hr manager";

    if (!isAdmin && !isSuperAdmin) {
      return res.status(403).json({ error: "Access denied. Admin role required." });
    }

    const companyId = req.user.companyId;
    const { status, limit = 50 } = req.query;

    let sql = `
      SELECT ava.*, u.name as user_name, u.email as user_email
      FROM attendance_verification_attempts ava
      LEFT JOIN users u ON ava.user_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (!isSuperAdmin && companyId) {
      params.push(companyId);
      sql += ` AND ava.company_id = $${params.length}`;
    }

    if (status) {
      params.push(status);
      sql += ` AND ava.status = $${params.length}`;
    }

    sql += ` ORDER BY ava.attempted_at DESC LIMIT $${params.length + 1}`;
    params.push(Math.min(Number(limit) || 50, 100));

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error("getVerificationAttempts error:", err);
    res.status(500).json({ error: "Failed to fetch verification attempts." });
  }
};

export const reviewVerificationAttempt = async (req, res) => {
  try {
    const { attemptId, decision, note } = req.body;
    if (!attemptId || !decision) {
      return res.status(400).json({ error: "attemptId and decision are required." });
    }

    const role = (req.user?.role || "").toLowerCase();
    const isSuperAdmin = role === "superadmin";
    const isAdmin = role === "admin" || role === "hr manager";

    if (!isAdmin && !isSuperAdmin) {
      return res.status(403).json({ error: "Access denied. Admin role required." });
    }

    const companyId = req.user.companyId;
    const result = await query(
      `UPDATE attendance_verification_attempts
       SET review_status = $1,
           reviewed_by = $2,
           reviewed_at = CURRENT_TIMESTAMP,
           review_decision = $1,
           review_note = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 ${!isSuperAdmin ? "AND company_id = $5" : ""}
       RETURNING *`,
      !isSuperAdmin ? [decision, req.user.id, note || "", attemptId, companyId] : [decision, req.user.id, note || "", attemptId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Verification attempt not found." });
    }

    auditService.logAudit({
      userId: req.user.id,
      action: "ATTENDANCE_VERIFICATION_REVIEWED",
      resourceType: "biometrics",
      resourceId: attemptId,
      details: { decision, note },
      req
    });

    res.json({ success: true, attempt: result.rows[0] });
  } catch (err) {
    console.error("reviewVerificationAttempt error:", err);
    res.status(500).json({ error: "Failed to review verification attempt." });
  }
};

export const createVerificationSession = async (req, res) => {
  const attemptId = "ava_" + crypto.randomUUID();
  const userId = req.user?.id;
  const companyId = req.user?.companyId;
  const { imageBase64, workMode = "office", location = {}, actionType = "check-in" } = req.body;

  if (!userId || !companyId) {
    return res.status(401).json({ error: "Authenticated session required." });
  }

  if (!imageBase64) {
    return res.status(400).json({ error: "Selfie image is required for biometric verification." });
  }

  // 1. Check face profile enrollment status
  let profile;
  try {
    const profileRes = await query(
      `SELECT * FROM employee_face_profiles WHERE user_id = $1 AND company_id = $2`,
      [userId, companyId]
    );
    profile = profileRes.rows[0];
  } catch (dbErr) {
    console.error("Error querying employee face profile:", dbErr);
    return res.status(500).json({ error: "Database error checking biometric enrollment." });
  }

  if (!profile || profile.enrollment_status !== "enrolled" || !profile.face_embedding) {
    // Record failed attempt
    try {
      await query(
        `INSERT INTO attendance_verification_attempts (
           id, user_id, company_id, work_mode, status, failure_category,
           gps_result, face_result, liveness_result, model, metadata
         ) VALUES ($1, $2, $3, $4, 'failed', 'enrollment_missing', 'not_checked', 'not_checked', 'not_checked', 'ArcFace', $5)`,
        [
          attemptId,
          userId,
          companyId,
          workMode,
          JSON.stringify({ actionType, reason: "Employee has not enrolled biometric template" })
        ]
      );
    } catch (insertErr) {
      console.warn("Could not insert failed attempt record:", insertErr.message);
    }

    auditService.logAudit({
      userId,
      action: "ATTENDANCE_VERIFICATION_FAILED",
      resourceType: "biometrics",
      resourceId: attemptId,
      details: { reason: "Missing or unapproved enrollment profile", actionType },
      req
    });

    return res.status(403).json({
      error: "No enrolled face template found. Please complete face enrollment first.",
      code: "ENROLLMENT_REQUIRED"
    });
  }

  // Parse enrolled embedding
  let enrolledEmbedding = profile.face_embedding;
  if (typeof enrolledEmbedding === "string") {
    try {
      enrolledEmbedding = JSON.parse(enrolledEmbedding);
    } catch (e) {
      enrolledEmbedding = null;
    }
  }

  if (!isValidEmbedding(enrolledEmbedding)) {
    return res.status(400).json({
      error: "Enrolled face template is corrupted. Please re-enroll your face.",
      code: "REENROLLMENT_REQUIRED"
    });
  }

  // 2. Validate GPS / workplace geofencing on server (fail-closed)
  let geoCheck;
  try {
    geoCheck = await validateServerGeofence({ companyId, location, user: req.user });
  } catch (geoErr) {
    console.error("Geofence validation error:", geoErr);
    geoCheck = { allowed: false, reason: "Workplace geofencing validation error.", gpsResult: "error" };
  }

  if (!geoCheck.allowed) {
    try {
      await query(
        `INSERT INTO attendance_verification_attempts (
           id, user_id, company_id, work_mode, status, failure_category,
           gps_result, face_result, liveness_result, model, metadata
         ) VALUES ($1, $2, $3, $4, 'failed', 'geofence_rejected', $5, 'not_checked', 'not_checked', 'ArcFace', $6)`,
        [
          attemptId,
          userId,
          companyId,
          workMode,
          geoCheck.gpsResult || "outside",
          JSON.stringify({ actionType, reason: geoCheck.reason, distance: geoCheck.distance })
        ]
      );
    } catch (insertErr) {
      console.warn("Could not insert failed geofence attempt:", insertErr.message);
    }

    auditService.logAudit({
      userId,
      action: "ATTENDANCE_VERIFICATION_FAILED",
      resourceType: "biometrics",
      resourceId: attemptId,
      details: { reason: geoCheck.reason, gpsResult: geoCheck.gpsResult, actionType },
      req
    });

    return res.status(400).json({
      error: geoCheck.reason || "Check-in denied: You are outside the permitted workplace area.",
      code: "GEOFENCE_FAILED"
    });
  }

  // 3. Call biometric microservice to compare selfie with enrolled embedding
  let verifyResult;
  try {
    verifyResult = await faceServiceClient.verifyFace({
      enrolledEmbedding,
      imageBase64
    });
  } catch (err) {
    if (err instanceof FaceServiceUnavailableError) {
      try {
        await query(
          `INSERT INTO attendance_verification_attempts (
             id, user_id, company_id, work_mode, status, failure_category,
             gps_result, face_result, liveness_result, model, metadata
           ) VALUES ($1, $2, $3, $4, 'failed', 'face_service_unavailable', $5, 'not_checked', 'not_checked', 'ArcFace', $6)`,
          [
            attemptId,
            userId,
            companyId,
            workMode,
            geoCheck.gpsResult || "not_required",
            JSON.stringify({ actionType, error: "Biometric service unreachable" })
          ]
        );
      } catch (insertErr) {
        console.warn("Could not insert service outage attempt:", insertErr.message);
      }

      auditService.logAudit({
        userId,
        action: "ATTENDANCE_VERIFICATION_SERVICE_OUTAGE",
        resourceType: "biometrics",
        resourceId: attemptId,
        details: { actionType },
        req
      });

      return res.status(503).json({
        error: "Biometric verification service is temporarily unavailable. Attendance cannot be recorded without biometric verification.",
        code: "BIOMETRIC_SERVICE_UNAVAILABLE"
      });
    }

    // Face service returned verification error (e.g. no face detected, multiple faces, bad image)
    const errorMsg = err.message || "Failed to process face verification.";
    let failureCat = "face_mismatch";
    if (errorMsg.toLowerCase().includes("no face")) failureCat = "no_face";
    else if (errorMsg.toLowerCase().includes("multiple")) failureCat = "multiple_faces";

    try {
      await query(
        `INSERT INTO attendance_verification_attempts (
           id, user_id, company_id, work_mode, status, failure_category,
           gps_result, face_result, liveness_result, model, metadata
         ) VALUES ($1, $2, $3, $4, 'failed', $5, $6, 'not_matched', 'not_checked', 'ArcFace', $7)`,
        [
          attemptId,
          userId,
          companyId,
          workMode,
          failureCat,
          geoCheck.gpsResult || "not_required",
          JSON.stringify({ actionType, error: errorMsg })
        ]
      );
    } catch (insertErr) {
      console.warn("Could not insert verification error attempt:", insertErr.message);
    }

    auditService.logAudit({
      userId,
      action: "ATTENDANCE_VERIFICATION_FAILED",
      resourceType: "biometrics",
      resourceId: attemptId,
      details: { reason: errorMsg, failureCategory: failureCat, actionType },
      req
    });

    return res.status(400).json({ error: errorMsg, code: failureCat.toUpperCase() });
  }

  // 4. Evaluate face match against configured similarity threshold (fail-closed: <= 0.40)
  const matchEval = evaluateFaceMatch(verifyResult);

  if (!matchEval.passed) {
    const failureCat = matchEval.failureCategory || "face_mismatch";
    try {
      await query(
        `INSERT INTO attendance_verification_attempts (
           id, user_id, company_id, work_mode, status, failure_category,
           gps_result, face_result, liveness_result, model, metadata
         ) VALUES ($1, $2, $3, $4, 'failed', $5, $6, 'not_matched', 'not_checked', 'ArcFace', $7)`,
        [
          attemptId,
          userId,
          companyId,
          workMode,
          failureCat,
          geoCheck.gpsResult || "not_required",
          JSON.stringify({
            actionType,
            distance: verifyResult.distance,
            threshold: matchEval.threshold,
            reason: matchEval.reason
          })
        ]
      );
    } catch (insertErr) {
      console.warn("Could not insert mismatch attempt:", insertErr.message);
    }

    auditService.logAudit({
      userId,
      action: "ATTENDANCE_VERIFICATION_FAILED",
      resourceType: "biometrics",
      resourceId: attemptId,
      details: {
        reason: matchEval.reason,
        distance: verifyResult.distance,
        threshold: matchEval.threshold,
        actionType
      },
      req
    });

    return res.status(400).json({
      error: matchEval.reason || "Face verification failed: Selfie does not match the enrolled face.",
      code: "FACE_MISMATCH",
      distance: verifyResult.distance
    });
  }

  // 5. Face matched successfully!
  // Record verified attempt
  try {
    await query(
      `INSERT INTO attendance_verification_attempts (
         id, user_id, company_id, work_mode, status, failure_category,
         gps_result, face_result, liveness_result, model, metadata
       ) VALUES ($1, $2, $3, $4, 'verified', NULL, $5, 'matched', 'not_checked', 'ArcFace', $6)`,
      [
        attemptId,
        userId,
        companyId,
        workMode,
        geoCheck.gpsResult || "not_required",
        JSON.stringify({
          actionType,
          distance: verifyResult.distance,
          threshold: matchEval.threshold,
          liveness_provider: "none",
          anti_spoofing_note: "2D ArcFace similarity check; active liveness presentation-attack detection not configured"
        })
      ]
    );
  } catch (insertErr) {
    console.warn("Could not insert verified attempt:", insertErr.message);
  }

  // Generate single-use verification session token
  const { rawToken, tokenHash } = generateVerificationSessionToken();
  const sessionId = "avs_" + crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minute TTL

  await query(
    `INSERT INTO attendance_verification_sessions (
       id, attempt_id, user_id, company_id, token_hash, provider, status, expires_at, action_type
     ) VALUES ($1, $2, $3, $4, $5, 'internal', 'issued', $6, $7)`,
    [sessionId, attemptId, userId, companyId, tokenHash, expiresAt.toISOString(), actionType]
  );

  auditService.logAudit({
    userId,
    action: "ATTENDANCE_VERIFICATION_SUCCESS",
    resourceType: "biometrics",
    resourceId: attemptId,
    details: {
      actionType,
      distance: verifyResult.distance,
      threshold: matchEval.threshold,
      sessionId
    },
    req
  });

  return res.json({
    success: true,
    verified: true,
    verificationSessionToken: rawToken,
    attemptId,
    expiresAt: expiresAt.toISOString(),
    status: "verified",
    liveness_result: "not_checked",
    distance: verifyResult.distance
  });
};


export const adminRevertPenalty = async (req, res) => {
  try {
    const { id } = req.params;
    const { resolutionNotes = "", taskId = null } = req.body || {};
    const adminId = req.user?.id;
    const userRole = (req.user?.role || "").toLowerCase();

    if (userRole !== "admin" && userRole !== "superadmin") {
      return res.status(403).json({ error: "Only an Admin or Superadmin can resolve compliance penalties and revert attendance." });
    }

    let existingRes = await query("SELECT * FROM attendance WHERE id = $1", [id]);
    if (existingRes.rows.length === 0) {
      existingRes = await query(
        "SELECT * FROM attendance WHERE user_id = $1 AND (date >= CURRENT_DATE - INTERVAL '1 day') ORDER BY date DESC, updated_at DESC LIMIT 1",
        [id]
      );
    }
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: "Attendance record not found." });
    }

    const record = existingRes.rows[0];

    // Fully unlock task(s) and restore employee attendance in a single action
    let updatedTasks = [];
    const nowIso = new Date().toISOString();

    if (taskId) {
      await query(
        `UPDATE tasks
         SET sla_penalty_applied = FALSE,
             last_reported_at = NOW(),
             updated_at = NOW(),
             metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{unlockedAt}', to_jsonb($2::text))
         WHERE id = $1`,
        [taskId, nowIso]
      );
    }

    // Clear penalty on all active tasks of this employee and restart 5-min reporting timer from now
    const allRes = await query(
      `UPDATE tasks
       SET sla_penalty_applied = FALSE,
           last_reported_at = NOW(),
           updated_at = NOW(),
           metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{unlockedAt}', to_jsonb($2::text))
       WHERE assigned_to = $1
         AND status NOT IN ('completed', 'cancelled', 'suspended')
       RETURNING *`,
      [record.user_id, nowIso]
    ).catch(() => ({ rows: [] }));
    if (allRes?.rows) updatedTasks = allRes.rows;

    // Restore employee attendance record and remove lock.
    // The employee was auto checked-out during the penalty lock. Keep the checkout record intact
    // and set status = 'checked-out' (or 'not-checked-in' if never checked in) so the employee
    // checks in again with biometric verification to resume their shift!
    const attRes = await query(
      `UPDATE attendance
       SET status = CASE WHEN check_in IS NOT NULL THEN 'checked-out' ELSE 'not-checked-in' END,
           is_admin_locked = FALSE,
           penalty_status = NULL,
           penalty_reason = NULL,
           penalized_by_task_id = NULL,
           auto_checked_out = FALSE,
           updated_at = NOW()
       WHERE id = $1 OR (user_id = $2 AND date = $3)
       RETURNING *`,
      [record.id, record.user_id, record.date]
    );
    await query(
      "DELETE FROM attendance WHERE user_id = $1 AND date = $2 AND id != $3",
      [record.user_id, record.date, record.id]
    ).catch(() => {});
    const updatedAttendance = attRes.rows[0];
    const updated = updatedAttendance || record;

    const io = req.app?.get("io");
    await sendNotificationOnce({
      userId: record.user_id,
      title: "Attendance Penalty Resolved by Admin",
      message: "Your attendance penalty has been resolved by Admin. Please check in with biometric verification to resume your shift.",
      type: "info",
      link: "/dashboard",
      io,
      activityType: "penalty_resolved",
      entityId: id
    });
    if (io) {
      const payload = {
        attendanceId: id,
        userId: record.user_id,
        status: updated.status,
        is_admin_locked: false,
        isAttendanceLocked: false,
        auto_checked_out: false,
        check_out: updated.check_out,
        checkOutTime: updated.check_out,
        check_in: updated.check_in,
        checkInTime: updated.check_in,
        sessions: updated.sessions,
        totalWorkingMinutes: updated.duration_minutes,
        accumulatedWorkingMinutes: updated.accumulated_working_minutes,
        resolutionNotes,
        updatedTasks: updatedTasks.map(t => ({
          id: t.id,
          slaPenaltyApplied: false,
          sla_penalty_applied: false,
          lastReportedAt: t.last_reported_at,
          last_reported_at: t.last_reported_at,
          attendanceStatus: updated.status,
          isAttendanceLocked: false
        }))
      };
      io.to(`user_${record.user_id}`).emit("attendance_penalty_reverted", payload);
      io.to(`user_${record.user_id}`).emit("attendance_updated", payload);
      if (record.company_id) {
        io.to(`company_${record.company_id}`).emit("attendance_penalty_reverted", payload);
        io.to(`company_${record.company_id}`).emit("attendance_updated", payload);
      }
      io.emit("attendance_penalty_reverted", payload);
      io.emit("attendance_updated", payload);

      // Also emit individual task updates
      for (const t of updatedTasks) {
        const tPayload = {
          id: t.id,
          sla_penalty_applied: false,
          slaPenaltyApplied: false,
          last_reported_at: t.last_reported_at,
          lastReportedAt: t.last_reported_at,
          employee_attendance_status: updated.status,
          employee_is_admin_locked: updated.is_admin_locked,
          attendanceStatus: updated.status,
          isAttendanceLocked: updated.is_admin_locked
        };
        io.to(`user_${record.user_id}`).emit("task_updated", tPayload);
        io.emit("task_updated", tPayload);
      }
    }

    auditService.logAudit({
      userId: adminId,
      action: "ATTENDANCE_PENALTY_REVERT",
      resourceType: "attendance",
      resourceId: id,
      details: { previousPenalty: record.penalty_status, previousReason: record.penalty_reason, resolutionNotes },
      req
    });

    res.json({
      message: "Attendance penalty resolved. Status restored to Present.",
      attendance: updated
    });
  } catch (err) {
    console.error("adminRevertPenalty error:", err);
    res.status(500).json({ error: "Failed to revert attendance penalty." });
  }
};

export const getFaceStatus = async (req, res) => {
  try {
    const targetUserId = req.query.userId || req.user.id;
    const role = (req.user?.role || "").toLowerCase();
    const isSuperAdmin = role === "superadmin";
    const isAdmin = role === "admin" || role === "hr manager" || role === "system admin";

    if (targetUserId !== req.user.id && !isAdmin && !isSuperAdmin) {
      return res.status(403).json({ error: "Access denied. Cannot view biometrics for other employees." });
    }

    const companyId = req.user.companyId;
    let sql = "SELECT * FROM employee_face_profiles WHERE user_id = $1";
    const params = [targetUserId];

    if (!isSuperAdmin && companyId) {
      sql += " AND company_id = $2";
      params.push(companyId);
    }

    const result = await query(sql, params);
    if (result.rows.length === 0) {
      return res.json({
        user_id: targetUserId,
        enrollment_status: "pending",
        is_enrolled: false,
        metadata: {}
      });
    }

    const row = result.rows[0];
    let meta = (row.metadata && typeof row.metadata === "object") ? { ...row.metadata } : {};
    if (typeof row.metadata === "string") {
      try { meta = JSON.parse(row.metadata); } catch {}
    }

    const reenrollPerm = await getActiveFaceReenrollmentPermission(targetUserId, row.company_id || companyId);
    if (reenrollPerm) {
      meta.reenrollmentAuthorized = true;
      meta.selfEnrollmentAuthorized = true;
    }

    res.json({
      id: row.id,
      user_id: row.user_id,
      company_id: row.company_id,
      enrollment_status: row.enrollment_status,
      is_enrolled: row.enrollment_status === "enrolled",
      embedding_model: row.embedding_model,
      enrolled_at: row.enrolled_at,
      consent_recorded_at: row.consent_recorded_at,
      metadata: meta,
      hasApprovedReenrollment: Boolean(reenrollPerm || meta.reenrollmentAuthorized)
    });
  } catch (err) {
    console.error("getFaceStatus error:", err);
    res.status(500).json({ error: "Failed to fetch biometric enrollment status." });
  }
};

export const authorizeFaceEnrollment = async (req, res) => {
  try {
    await ensureFaceReenrollmentTable();
    const { targetUserId, authorized = true } = req.body;
    if (!targetUserId) {
      return res.status(400).json({ error: "targetUserId is required." });
    }

    const role = (req.user?.role || "").toLowerCase();
    const isSuperAdmin = role === "superadmin";
    const isAdmin = role === "admin" || role === "hr manager" || role === "system admin";

    if (!isAdmin && !isSuperAdmin) {
      return res.status(403).json({ error: "Only administrators and HR personnel can authorize face enrollment." });
    }

    const companyId = req.user.companyId;
    const userCheck = await query("SELECT id, name, email, company_id FROM users WHERE id = $1", [targetUserId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: "Target employee not found." });
    }

    const targetUser = userCheck.rows[0];
    if (!isSuperAdmin && targetUser.company_id !== companyId) {
      return res.status(403).json({ error: "Access denied. Target employee belongs to another organization." });
    }

    const profileId = `${targetUserId}_profile`;
    const now = new Date().toISOString();

    if (authorized === false) {
      await query(
        `UPDATE employee_face_profiles
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2 OR id = $3`,
        [
          JSON.stringify({
            selfEnrollmentAuthorized: false,
            reenrollmentAuthorized: false,
            revokedAt: now,
            revokedBy: req.user.id
          }),
          targetUserId,
          profileId
        ]
      );

      await query(
        `UPDATE face_reenrollment_requests
         SET status = 'rejected',
             rejection_reason = 'Authorization revoked by administrator',
             permission_expires_at = NULL,
             updated_at = NOW()
         WHERE employee_id = $1 AND company_id = $2 AND status = 'approved'`,
        [targetUserId, targetUser.company_id || companyId]
      );

      auditService.logAudit({
        userId: req.user.id,
        action: "BIOMETRIC_ENROLLMENT_REVOKED",
        resourceType: "biometrics",
        resourceId: profileId,
        details: { targetUserId, revokedBy: req.user.id },
        req
      });

      return res.json({
        success: true,
        message: "Face re-enrollment access revoked successfully for employee.",
        targetUserId,
        authorized: false
      });
    }

    const authMeta = JSON.stringify({
      selfEnrollmentAuthorized: true,
      reenrollmentAuthorized: true,
      authorizedAt: now,
      authorizedBy: req.user.id
    });

    const existingProfileRes = await query(
      "SELECT id FROM employee_face_profiles WHERE user_id = $1 LIMIT 1",
      [targetUserId]
    );

    if (existingProfileRes.rows.length > 0) {
      await query(
        `UPDATE employee_face_profiles
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2`,
        [authMeta, targetUserId]
      );
    } else {
      await query(
        `INSERT INTO employee_face_profiles (id, user_id, company_id, enrollment_status, metadata, updated_at)
         VALUES ($1, $2, $3, 'pending', $4::jsonb, CURRENT_TIMESTAMP)`,
        [profileId, targetUserId, targetUser.company_id || companyId, authMeta]
      );
    }

    const requestId = `face_reenroll_${crypto.randomUUID()}`;
    await query(
      `INSERT INTO face_reenrollment_requests (id, employee_id, company_id, reason, status, reviewed_by, reviewed_at, permission_expires_at, requested_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'admin authorization', 'approved', $4, NOW(), NOW() + INTERVAL '${FACE_REENROLL_VALIDITY_HOURS} hours', NOW(), NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         status = 'approved',
         reviewed_by = EXCLUDED.reviewed_by,
         reviewed_at = NOW(),
         permission_expires_at = NOW() + INTERVAL '${FACE_REENROLL_VALIDITY_HOURS} hours',
         updated_at = NOW()`,
      [requestId, targetUserId, targetUser.company_id || companyId, req.user.id]
    );

    auditService.logAudit({
      userId: req.user.id,
      action: "BIOMETRIC_ENROLLMENT_AUTHORIZED",
      resourceType: "biometrics",
      resourceId: profileId,
      details: { targetUserId, authorizedBy: req.user.id },
      req
    });

    res.json({ success: true, message: "Face self-enrollment authorized successfully for employee.", targetUserId, authorized: true });
  } catch (err) {
    console.error("authorizeFaceEnrollment error:", err);
    res.status(500).json({ error: "Failed to authorize face enrollment." });
  }
};

export const enrollFace = async (req, res) => {
  try {
    const { imageBase64, consentGiven, biometricConsent, targetUserId, userId } = req.body;
    const consent = consentGiven !== undefined ? consentGiven : (biometricConsent !== undefined ? biometricConsent : true);
    const resolvedTargetId = targetUserId || userId || req.user.id;
    const isSelf = resolvedTargetId === req.user.id;
    const role = (req.user?.role || "").toLowerCase();
    const isSuperAdmin = role === "superadmin";
    const isAdmin = role === "admin" || isSuperAdmin || role === "hr manager";

    if (!isSelf && !isAdmin) {
      return res.status(403).json({ error: "Unauthorized: Cannot enroll face biometrics for another user." });
    }

    let targetCompanyId = req.user.companyId;

    if (!isSelf) {
      const userCheck = await query(
        "SELECT id, name, email, company_id, status FROM users WHERE id = $1",
        [resolvedTargetId]
      );
      if (userCheck.rows.length === 0) {
        return res.status(404).json({ error: "Target employee not found." });
      }
      const targetUser = userCheck.rows[0];
      if (!isSuperAdmin && targetUser.company_id !== req.user.companyId) {
        return res.status(403).json({
          error: "Access denied. Target employee belongs to another organization.",
          code: "CROSS_TENANT_ACCESS_DENIED"
        });
      }
      targetCompanyId = targetUser.company_id || req.user.companyId;
    }

    const existingProfileCheck = await query(
      "SELECT * FROM employee_face_profiles WHERE user_id = $1 AND company_id = $2",
      [resolvedTargetId, targetCompanyId]
    );
    const existingProfile = existingProfileCheck.rows[0] || null;
    const isAlreadyEnrolled = Boolean(
      existingProfile &&
      existingProfile.enrollment_status === "enrolled" &&
      existingProfile.face_embedding
    );

    if (isSelf && !isAdmin) {
      const activePermission = await getActiveFaceReenrollmentPermission(resolvedTargetId, targetCompanyId);
      const isReenrollPermitted = Boolean(
        existingProfile?.metadata?.reenrollmentAuthorized ||
        activePermission
      );
      const isAuthorized = Boolean(
        existingProfile?.metadata?.selfEnrollmentAuthorized ||
        isReenrollPermitted
      );

      if (!isAuthorized) {
        return res.status(403).json({
          error: "Face self-enrollment has not been authorized by HR or an Administrator.",
          code: "SELF_ENROLLMENT_NOT_AUTHORIZED"
        });
      }

      if (isAlreadyEnrolled && !isReenrollPermitted) {
        return res.status(403).json({
          error: "Face template is already enrolled. Self-replacement is not permitted. Please contact your administrator.",
          code: "SELF_ENROLLMENT_NOT_AUTHORIZED"
        });
      }
    }

    const validation = validateEnrollmentPayload({ imageBase64, consentGiven: consent });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    let microserviceResult;
    try {
      microserviceResult = await faceServiceClient.enrollFace(imageBase64);
    } catch (svcErr) {
      auditService.logAudit({
        userId: req.user.id,
        action: isAlreadyEnrolled ? "BIOMETRIC_REPLACEMENT_FAILED" : "BIOMETRIC_ENROLLMENT_FAILED",
        resourceType: "biometrics",
        resourceId: existingProfile?.id || `${resolvedTargetId}_profile`,
        details: {
          reason: svcErr.message,
          targetUserId: resolvedTargetId,
          mode: isAlreadyEnrolled ? "replacement" : "enrollment"
        },
        status: "FAILURE",
        severity: "WARNING",
        req
      });
      return res.status(svcErr.status || 400).json({ error: svcErr.message });
    }

    const { embedding, model, embedding_dimension, quality_score, face_count } = microserviceResult;

    if (!isValidEmbedding(embedding, 512)) {
      return res.status(500).json({ error: "Biometric service generated an invalid face embedding vector." });
    }

    const now = new Date().toISOString();

    if (isAlreadyEnrolled) {
      const profileId = existingProfile.id;
      const updatedMetadata = {
        ...(existingProfile.metadata || {}),
        qualityScore: quality_score,
        faceCount: face_count,
        lastReplacementAt: now,
        replacedBy: req.user.id,
        replacedByRole: req.user.role || (isAdmin ? "admin" : "employee"),
        replacementCount: ((existingProfile.metadata && existingProfile.metadata.replacementCount) || 0) + 1,
        previousEnrolledAt: existingProfile.enrolled_at,
        reenrollmentAuthorized: false
      };

      await query(
        `UPDATE employee_face_profiles
         SET face_embedding = $1,
             embedding_model = $2,
             embedding_dimension = $3,
             enrollment_status = 'enrolled',
             enrolled_by = $4,
             enrolled_at = CURRENT_TIMESTAMP,
             metadata = $5,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $6`,
        [
          JSON.stringify(embedding),
          model || "ArcFace",
          embedding_dimension || 512,
          req.user.id,
          JSON.stringify(updatedMetadata),
          profileId
        ]
      );

      if (isSelf && !isAdmin) {
        const approval = await query(
          `SELECT *
           FROM face_reenrollment_requests
           WHERE employee_id = $1 AND company_id = $2 AND status = 'approved' AND permission_expires_at > NOW() AND used_at IS NULL
           ORDER BY requested_at DESC
           LIMIT 1`,
          [resolvedTargetId, targetCompanyId]
        );

        if (approval.rows[0]) {
          await query(
            `UPDATE face_reenrollment_requests
             SET used_at = NOW(),
                 permission_expires_at = NULL,
                 updated_at = NOW()
             WHERE id = $1`,
            [approval.rows[0].id]
          );
        }
      }

      auditService.logAudit({
        userId: req.user.id,
        action: "BIOMETRIC_TEMPLATE_REPLACED",
        resourceType: "biometrics",
        resourceId: profileId,
        details: {
          targetUserId: resolvedTargetId,
          replacedBy: req.user.id,
          mode: "replacement",
          model: model || "ArcFace",
          qualityScore: quality_score
        },
        req
      });

      return res.json({
        success: true,
        mode: "replacement",
        enrollment_status: "enrolled",
        enrolled_at: now,
        model: model || "ArcFace",
        message: "Face reference template replaced and validated successfully."
      });
    }

    const profileId = existingProfile?.id || `${resolvedTargetId}_profile`;
    const newMetadata = {
      ...(existingProfile?.metadata || {}),
      qualityScore: quality_score,
      faceCount: face_count,
      enrolledByRole: req.user.role,
      consentRecorded: true,
      enrolledBy: req.user.id,
      reenrollmentAuthorized: false
    };

    if (existingProfile) {
      await query(
        `UPDATE employee_face_profiles
         SET face_embedding = $1,
             embedding_model = $2,
             embedding_dimension = $3,
             enrollment_status = 'enrolled',
             enrolled_by = $4,
             enrolled_at = CURRENT_TIMESTAMP,
             consent_recorded_at = COALESCE(consent_recorded_at, CURRENT_TIMESTAMP),
             metadata = $5,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $6`,
        [
          JSON.stringify(embedding),
          model || "ArcFace",
          embedding_dimension || 512,
          req.user.id,
          JSON.stringify(newMetadata),
          existingProfile.id
        ]
      );
    } else {
      await query(
        `INSERT INTO employee_face_profiles (
           id, user_id, company_id, enrollment_status, face_embedding,
           embedding_model, embedding_dimension, enrolled_by, enrolled_at,
           consent_recorded_at, metadata, updated_at
         ) VALUES ($1, $2, $3, 'enrolled', $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $8, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO UPDATE SET
           enrollment_status = 'enrolled',
           face_embedding = EXCLUDED.face_embedding,
           embedding_model = EXCLUDED.embedding_model,
           embedding_dimension = EXCLUDED.embedding_dimension,
           enrolled_by = EXCLUDED.enrolled_by,
           enrolled_at = CURRENT_TIMESTAMP,
           consent_recorded_at = COALESCE(employee_face_profiles.consent_recorded_at, CURRENT_TIMESTAMP),
           metadata = COALESCE(employee_face_profiles.metadata, '{}'::jsonb) || EXCLUDED.metadata,
           updated_at = CURRENT_TIMESTAMP`,
        [
          profileId,
          resolvedTargetId,
          targetCompanyId,
          JSON.stringify(embedding),
          model || "ArcFace",
          embedding_dimension || 512,
          req.user.id,
          JSON.stringify(newMetadata)
        ]
      );
    }

    auditService.logAudit({
      userId: req.user.id,
      action: "BIOMETRIC_ENROLLMENT_SUCCESS",
      resourceType: "biometrics",
      resourceId: profileId,
      details: {
        targetUserId: resolvedTargetId,
        enrolledBy: req.user.id,
        mode: "enrollment",
        model: model || "ArcFace"
      },
      req
    });

    return res.json({
      success: true,
      mode: "enrollment",
      enrollment_status: "enrolled",
      enrolled_at: now,
      model: model || "ArcFace",
      message: "Face reference template enrolled successfully."
    });
  } catch (err) {
    console.error("enrollFace error:", err);
    res.status(500).json({ error: "Internal server error during face enrollment." });
  }
};

export const revokeFaceEnrollment = async (req, res) => {
  try {
    const { targetUserId, userId, reason = "Administrator revocation" } = req.body;
    const resolvedTargetId = targetUserId || userId || req.user.id;
    const isSelf = resolvedTargetId === req.user.id;
    const role = (req.user?.role || "").toLowerCase();
    const isSuperAdmin = role === "superadmin";
    const isAdmin = role === "admin" || isSuperAdmin || role === "hr manager";

    if (!isSelf && !isAdmin) {
      return res.status(403).json({ error: "Access denied. Cannot revoke biometric profile for another user." });
    }

    let targetCompanyId = req.user.companyId;
    if (!isSelf) {
      const userCheck = await query("SELECT id, company_id FROM users WHERE id = $1", [resolvedTargetId]);
      if (userCheck.rows.length === 0) {
        return res.status(404).json({ error: "Target employee not found." });
      }
      if (!isSuperAdmin && userCheck.rows[0].company_id !== req.user.companyId) {
        return res.status(403).json({ error: "Access denied. Target employee belongs to another organization." });
      }
      targetCompanyId = userCheck.rows[0].company_id || req.user.companyId;
    }

    await query(
      `UPDATE employee_face_profiles
       SET enrollment_status = 'suspended',
           face_embedding = NULL,
           reenrollment_requested_at = CURRENT_TIMESTAMP,
           reenrollment_reason = $1,
           metadata = COALESCE(metadata, '{}'::jsonb) || '{"selfEnrollmentAuthorized": false, "reenrollmentAuthorized": false}'::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $2 AND company_id = $3`,
      [reason, resolvedTargetId, targetCompanyId]
    );

    auditService.logAudit({
      userId: req.user.id,
      action: "BIOMETRIC_ENROLLMENT_REVOKED",
      resourceType: "biometrics",
      resourceId: `${resolvedTargetId}_profile`,
      details: { targetUserId: resolvedTargetId, reason },
      req
    });

    res.json({ success: true, message: "Biometric template revoked successfully." });
  } catch (err) {
    console.error("revokeFaceEnrollment error:", err);
    res.status(500).json({ error: "Failed to revoke biometric template." });
  }
};

const addNotification = async ({ userId, title, message, type = "info", link = "", req = null }) => {
  if (!userId || !title || !message) return null;

  const id = `notif_${crypto.randomUUID()}`;
  const result = await query(
    `INSERT INTO notifications (id, user_id, title, message, type, read, link)
     VALUES ($1, $2, $3, $4, $5, FALSE, $6)
     RETURNING *`,
    [id, userId, title, message, type, link]
  );

  const notification = result.rows[0];
  const io = req?.app?.get("io");
  if (io) {
    const formatted = {
      id: notification.id,
      _id: notification.id,
      userId: notification.user_id,
      title: notification.title,
      message: notification.message,
      type: notification.type,
      read: notification.read,
      link: notification.link,
      createdAt: notification.created_at,
      created_at: notification.created_at,
      timestamp: notification.created_at
    };
    io.emit(`notification_${userId}`, formatted);
  }

  return notification;
};

export const getAttendance = async (req, res) => {
  try {
    const { userId, companyId, startDate, endDate, date } = req.query;
    const isSuperAdmin = req.user?.role?.toLowerCase() === "superadmin";
    const targetCompanyId = isSuperAdmin && companyId ? companyId : req.user?.companyId;

    let sql = `
      SELECT a.*, a.date::text as date_str, a.id as "_id", u.name as user_name, u.name as "userName",
             u.email as user_email, u.department as "userDept", u.department
      FROM attendance a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (req.user && req.user.role === "employee") {
      params.push(req.user.id);
      sql += ` AND a.user_id = $${params.length}`;
    } else if (userId) {
      params.push(userId);
      sql += ` AND a.user_id = $${params.length}`;
    }

    if (targetCompanyId) {
      params.push(targetCompanyId);
      sql += ` AND a.company_id = $${params.length}`;
    }

    if (date) {
      params.push(date);
      sql += ` AND a.date = $${params.length}`;
    }

    if (startDate && endDate) {
      params.push(startDate);
      sql += ` AND a.date >= $${params.length}`;
      params.push(endDate);
      sql += ` AND a.date <= $${params.length}`;
    }

    sql += " ORDER BY a.date DESC, a.check_in DESC LIMIT 1000";
    const result = await query(sql, params);

    const logs = result.rows.map(row => {
      const checkInDate = row.check_in ? new Date(row.check_in) : null;
      const checkOutDate = row.check_out ? new Date(row.check_out) : null;
      const formatTime = (d) => d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : "";

      let totalMins = Number(row.duration_minutes) || Number(row.accumulated_working_minutes) || 0;
      if (Array.isArray(row.sessions) && row.sessions.length > 0) {
        const totalSessionMins = row.sessions.reduce((acc, s) => acc + (Number(s.durationMinutes) || 0), 0);
        totalMins = Math.max(totalMins, totalSessionMins);
      }
      if (totalMins <= 0 && checkInDate && checkOutDate && checkOutDate >= checkInDate) {
        let totalBreakMins = 0;
        const breaks = Array.isArray(row.breaks) ? row.breaks : [];
        breaks.forEach(b => {
          if (b.start && b.end) {
            totalBreakMins += Math.max(0, Math.floor((new Date(b.end) - new Date(b.start)) / 60000));
          }
        });
        const rawDiffMins = Math.floor((checkOutDate.getTime() - checkInDate.getTime()) / 60000);
        if (rawDiffMins >= 1440) {
          // If checkOut was stamped on a subsequent day (e.g. employee forgot to check out),
          // calculate true shift duration based on shift time-of-day
          const inMinsOfDay = checkInDate.getHours() * 60 + checkInDate.getMinutes();
          const outMinsOfDay = checkOutDate.getHours() * 60 + checkOutDate.getMinutes();
          const sameDayMins = outMinsOfDay >= inMinsOfDay
            ? (outMinsOfDay - inMinsOfDay)
            : (1440 - inMinsOfDay + outMinsOfDay);
          totalMins = Math.min(1440, Math.max(0, sameDayMins - totalBreakMins));
        } else {
          totalMins = Math.max(0, rawDiffMins - totalBreakMins);
        }
      }

      // Single-day shift safety constraint: working minutes cannot exceed 24 hours (1440 minutes)
      if (totalMins > 1440) {
        if (checkInDate && checkOutDate) {
          const inMinsOfDay = checkInDate.getHours() * 60 + checkInDate.getMinutes();
          const outMinsOfDay = checkOutDate.getHours() * 60 + checkOutDate.getMinutes();
          const sameDayMins = outMinsOfDay >= inMinsOfDay
            ? (outMinsOfDay - inMinsOfDay)
            : (1440 - inMinsOfDay + outMinsOfDay);
          totalMins = Math.min(1440, Math.max(0, sameDayMins));
        } else {
          totalMins = 1440;
        }
      }

      const durationHours = totalMins > 0 
        ? (totalMins / 60).toFixed(2) 
        : (row.check_out ? "0.00" : (row.check_in ? "Live" : "0.00"));

      // Extract reliable local YYYY-MM-DD from date_str, id suffix, or check_in
      let dateStr = row.date_str;
      if (!dateStr || dateStr.includes("T") || dateStr.includes(" ")) {
        if (row.id && /_\d{4}-\d{2}-\d{2}$/.test(row.id)) {
          dateStr = row.id.split("_").pop();
        } else if (checkInDate) {
          dateStr = checkInDate.toISOString().split("T")[0];
        } else if (row.date instanceof Date) {
          dateStr = row.date.toISOString().split("T")[0];
        } else if (row.date) {
          dateStr = String(row.date).split("T")[0];
        }
      }

      let frontendStatus = "not-checked-in";
      let currentBreakTimerEnd = null;
      if (row.is_admin_locked || row.penalty_status || row.status === "absent") {
        frontendStatus = "absent";
      } else if (row.check_out) {
        frontendStatus = "checked-out";
      } else if (Array.isArray(row.breaks) && row.breaks.some(b => !b.end && !b.resumeTime)) {
        frontendStatus = "on-break";
        const activeB = row.breaks.find(b => !b.end && !b.resumeTime);
        if (activeB) {
          const bStart = new Date(activeB.start || activeB.startTime).getTime();
          const bType = activeB.breakType || activeB.type || "short";
          const durSec = bType === "bio" ? 900 : 1800;
          currentBreakTimerEnd = new Date(bStart + durSec * 1000).toISOString();
        }
      } else if (row.check_in) {
        frontendStatus = "checked-in";
      }

      const parsedBreaks = Array.isArray(row.breaks)
        ? row.breaks
        : (typeof row.breaks === "string" ? (() => { try { const p = JSON.parse(row.breaks); return Array.isArray(p) ? p : []; } catch { return []; } })() : []);

      return {
        ...row,
        id: row.id,
        userId: row.user_id,
        companyId: row.company_id,
        date: dateStr,
        date_str: dateStr,
        checkIn: formatTime(checkInDate),
        checkOut: formatTime(checkOutDate),
        checkInTime: row.check_in || null,
        checkOutTime: row.check_out || null,
        checkInLocation: row.check_in_location || row.location,
        checkOutLocation: row.check_out_location,
        totalHours: durationHours,
        totalWorkingMinutes: totalMins,
        durationMinutes: totalMins,
        duration_minutes: totalMins,
        status: frontendStatus,
        breaks: parsedBreaks,
        currentBreakTimerEnd
      };
    });

    res.json(logs);
  } catch (err) {
    console.error("getAttendance error:", err);
    res.status(500).json({ error: "Failed to fetch attendance logs." });
  }
};

export const checkIn = async (req, res) => {
  try {
    let userId = req.user?.id || req.body.userId;
    if (typeof userId === "object" && userId !== null) {
      userId = userId.uid || userId.id;
    }
    const companyId = req.user?.companyId || req.body.companyId || req.body.userId?.companyId;
    const today = req.body.date || new Date().toISOString().split("T")[0];
    const now = new Date().toISOString();
    const { location, workMode = "office", verificationSessionToken } = req.body;
    const recordId = `${userId}_${today}`;
    // Compliance lock check removed per user request - employees are not blocked from check-in

    if (!verificationSessionToken) {
      return res.status(400).json({
        error: "Biometric verification is required. Please capture a selfie to check in."
      });
    }

    const tokenHash = hashToken(verificationSessionToken);
    const sessionRes = await query(
      `UPDATE attendance_verification_sessions
       SET status = 'consumed', consumed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE token_hash = $1
         AND user_id = $2
         AND company_id = $3
         AND status = 'issued'
         AND expires_at > CURRENT_TIMESTAMP
       RETURNING *`,
      [tokenHash, userId, companyId]
    );

    if (sessionRes.rows.length === 0) {
      auditService.logAudit({
        userId,
        action: "ATTENDANCE_VERIFICATION_REPLAY_REJECTED",
        resourceType: "attendance",
        resourceId: `session_${tokenHash.slice(0, 10)}`,
        details: { reason: "Invalid, expired, or already-consumed verification token", action: "check-in" },
        req
      });
      return res.status(403).json({
        error: "Biometric verification session is invalid, expired, or has already been used. Please capture a fresh selfie."
      });
    }

    const geoCheck = await validateServerGeofence({ companyId, location, user: req.user });
    if (!geoCheck.allowed) {
      return res.status(400).json({
        error: geoCheck.reason || "Check-in denied: You are outside the permitted workplace area."
      });
    }

    const existingRes = await query(
      `SELECT * FROM attendance 
       WHERE (id = $1 OR (user_id = $2 AND date = $3))
       ORDER BY check_in DESC NULLS LAST, created_at DESC LIMIT 1`,
      [recordId, userId, today]
    );

    // Fetch employee shift details for accurate Present vs Late determination
    const userRes = await query(
      `SELECT id, name, company_id, shift_start, shift_end FROM users WHERE id = $1`,
      [userId]
    );
    const userRecord = userRes.rows[0];
    const shiftStartStr = userRecord?.shift_start || "09:00";
    const parseTimeStrMins = (tStr) => {
      if (!tStr) return 540;
      const m = String(tStr).match(/(\d{1,2}):(\d{2})/);
      return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 540;
    };
    const shiftStartMins = parseTimeStrMins(shiftStartStr);

    const checkInDate = new Date(now);
    const checkInLocalMins = checkInDate.getHours() * 60 + checkInDate.getMinutes();
    const isLateCheckIn = checkInLocalMins > (shiftStartMins + 5);
    const calculatedStatus = isLateCheckIn ? "late" : "present";

    // Leave Integration: Check if employee has an approved leave record for today
    let attNotes = null;
    const leaveCheckRes = await query(
      `SELECT * FROM leave_requests 
       WHERE user_id = $1 
         AND status = 'approved'
         AND start_date <= $2 AND end_date >= $2
       ORDER BY created_at DESC LIMIT 1`,
      [userId, today]
    );

    if (leaveCheckRes.rows.length > 0) {
      const approvedLeave = leaveCheckRes.rows[0];
      const isFirstCheckInToday = existingRes.rows.length === 0 || !existingRes.rows[0].check_in || existingRes.rows[0].status === "on-leave";

      if (isFirstCheckInToday) {
        // Employee came to work on their approved leave day:
        // Actual attendance takes priority. Adjust leave quota back by 1 day.
        const leaveTypeLower = String(approvedLeave.leave_type || "").toLowerCase();
        let quotaCol = "casual_leave_quota";
        let maxQuota = 25;
        if (leaveTypeLower.includes("sick")) {
          quotaCol = "sick_leave_quota";
          maxQuota = 10;
        } else if (leaveTypeLower.includes("casual") || leaveTypeLower.includes("paid")) {
          quotaCol = "paid_leave_quota";
          maxQuota = 6;
        } else if (leaveTypeLower.includes("annual")) {
          quotaCol = "casual_leave_quota";
          maxQuota = 25;
        }

        await query(
          `UPDATE users
           SET ${quotaCol} = LEAST(${maxQuota}, COALESCE(${quotaCol}, 0) + 1),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [userId]
        ).catch(e => console.error("Error adjusting leave quota on employee check-in:", e));

        attNotes = `Checked in during approved ${approvedLeave.leave_type || 'Leave'} - actual attendance overrides leave for ${today}. 1 day quota adjusted.`;

        auditService.logAudit({
          userId,
          action: "ATTENDANCE_OVERRIDE_APPROVED_LEAVE",
          resourceType: "attendance",
          resourceId: recordId,
          details: {
            leaveId: approvedLeave.id,
            leaveType: approvedLeave.leave_type,
            date: today,
            quotaRestored: quotaCol,
            status: calculatedStatus
          },
          req
        });
      }
    }

    let sessions = [];
    let accumulatedMins = 0;
    let row;

    if (existingRes.rows.length > 0) {
      const prev = existingRes.rows[0];
      const targetId = prev.id || recordId;

      if (prev.is_admin_locked) {
        return res.status(403).json({
          error: "Your attendance is currently locked by Administrator. Please contact your Admin to unlock your attendance before checking in."
        });
      }

      // 1. Ensure any previous sessions are closed and deduplicated
      let rawSessions = Array.isArray(prev.sessions) ? [...prev.sessions] : [];
      const cleanSessions = [];
      const seenCheckIns = new Set();

      rawSessions.forEach((s, idx) => {
        if (!s || !s.checkIn) return;
        const inMs = new Date(s.checkIn).getTime();
        const key = Math.floor(inMs / 10000);
        if (seenCheckIns.has(key)) return;
        seenCheckIns.add(key);

        const outMs = s.checkOut ? new Date(s.checkOut).getTime() : 0;
        let dur = Number(s.durationMinutes) || 0;
        let cOut = s.checkOut;

        // If this previous session was never closed, close it at prev.check_out or now
        if (!cOut) {
          const effectiveOut = prev.check_out ? new Date(prev.check_out) : new Date(now);
          cOut = effectiveOut.toISOString();
          dur = Math.max(1, Math.floor((effectiveOut.getTime() - inMs) / 60000));
        } else if (dur <= 0 && outMs > inMs) {
          dur = Math.max(1, Math.floor((outMs - inMs) / 60000));
        }

        cleanSessions.push({
          sessionId: s.sessionId || `sess_${inMs}_${idx + 1}`,
          checkIn: new Date(s.checkIn).toISOString(),
          checkOut: cOut,
          durationMinutes: dur,
          breaks: Array.isArray(s.breaks) ? s.breaks : [],
          checkInLocation: s.checkInLocation || {},
          checkOutLocation: s.checkOutLocation || {}
        });
      });

      // If prev had check_in & check_out not present in sessions, add it
      if (prev.check_in && prev.check_out) {
        const pInMs = new Date(prev.check_in).getTime();
        const pOutMs = new Date(prev.check_out).getTime();
        const pKey = Math.floor(pInMs / 10000);
        if (!seenCheckIns.has(pKey) && pOutMs >= pInMs) {
          const pDur = Math.max(1, Math.floor((pOutMs - pInMs) / 60000));
          cleanSessions.push({
            sessionId: `sess_${pInMs}_prev`,
            checkIn: new Date(prev.check_in).toISOString(),
            checkOut: new Date(prev.check_out).toISOString(),
            durationMinutes: pDur,
            breaks: Array.isArray(prev.breaks) ? prev.breaks : [],
            checkInLocation: prev.check_in_location || {},
            checkOutLocation: prev.check_out_location || {}
          });
        }
      }

      accumulatedMins = cleanSessions.reduce((acc, s) => acc + (Number(s.durationMinutes) || 0), 0);

      // 2. Append the single new active session for this check-in
      cleanSessions.push({
        sessionId: `sess_${Date.now()}_${cleanSessions.length + 1}`,
        checkIn: now,
        checkOut: null,
        durationMinutes: 0,
        breaks: [],
        checkInLocation: location || {}
      });
      sessions = cleanSessions;

      const updateRes = await query(
        `UPDATE attendance
         SET id = $5,
             check_in = $1,
             check_out = NULL,
             status = $7,
             check_in_location = $2,
             sessions = $3,
             accumulated_working_minutes = $4,
             duration_minutes = $4,
             breaks = '[]'::jsonb,
             notes = COALESCE($8, notes),
             is_admin_locked = FALSE,
             penalty_status = NULL,
             penalty_reason = NULL,
             penalized_by_task_id = NULL,
             auto_checked_out = FALSE,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $6 OR id = $5
         RETURNING *`,
        [now, JSON.stringify(location || {}), JSON.stringify(sessions), accumulatedMins, recordId, targetId, calculatedStatus, attNotes]
      );
      row = updateRes.rows[0];

      // Remove any extra duplicates for this user and day
      await query(
        `DELETE FROM attendance WHERE user_id = $1 AND date = $2 AND id != $3`,
        [userId, today, recordId]
      ).catch(() => {});
    } else {
      sessions = [{
        sessionId: `sess_${Date.now()}_1`,
        checkIn: now,
        checkOut: null,
        durationMinutes: 0,
        breaks: [],
        checkInLocation: location || {}
      }];

      const insertRes = await query(
        `INSERT INTO attendance (id, user_id, company_id, date, check_in, status, notes, work_mode, check_in_location, location, sessions, accumulated_working_minutes, duration_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, 0, 0)
         ON CONFLICT (id) DO UPDATE SET
           check_in = EXCLUDED.check_in,
           check_out = NULL,
           status = EXCLUDED.status,
           notes = COALESCE(EXCLUDED.notes, attendance.notes),
           check_in_location = EXCLUDED.check_in_location,
           sessions = EXCLUDED.sessions,
           is_admin_locked = FALSE,
           penalty_status = NULL,
           penalty_reason = NULL,
           auto_checked_out = FALSE,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [recordId, userId, companyId, today, now, calculatedStatus, attNotes || "Office Check-in", workMode, JSON.stringify(location || {}), JSON.stringify(sessions)]
      );
      row = insertRes.rows[0];
    }

    const formatTime = (d) => d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : "";

    auditService.logAudit({
      userId,
      action: "ATTENDANCE_CLOCK_IN",
      resourceType: "attendance",
      resourceId: row.id,
      details: { date: today, workMode, location, status: calculatedStatus, accumulatedWorkingMinutes: accumulatedMins, verificationSessionId: sessionRes.rows[0].id },
      req
    });

    res.json({
      ...row,
      id: row.id,
      userId: row.user_id,
      companyId: row.company_id,
      date: today,
      checkIn: formatTime(checkInDate),
      checkInTime: row.check_in || now,
      checkInLocation: row.check_in_location || row.location,
      sessions,
      accumulatedWorkingMinutes: accumulatedMins,
      totalWorkingMinutes: accumulatedMins,
      durationMinutes: accumulatedMins,
      duration_minutes: accumulatedMins,
      status: calculatedStatus === "late" ? "Late" : "Present"
    });
  } catch (err) {
    console.error("checkIn error:", err);
    res.status(500).json({ error: "Check-in failed." });
  }
};

export const checkOut = async (req, res) => {
  try {
    let userId = req.user?.id || req.body.userId;
    if (typeof userId === "object" && userId !== null) {
      userId = userId.uid || userId.id;
    }
    const companyId = req.user?.companyId || req.body.companyId;
    const today = req.body.date || new Date().toISOString().split("T")[0];
    const now = new Date().toISOString();
    const { location, verificationSessionToken } = req.body;

    if (!verificationSessionToken) {
      return res.status(400).json({
        error: "Biometric verification is required. Please capture a selfie to check out."
      });
    }

    const tokenHash = hashToken(verificationSessionToken);
    const sessionRes = await query(
      `UPDATE attendance_verification_sessions
       SET status = 'consumed', consumed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE token_hash = $1
         AND user_id = $2
         AND company_id = $3
         AND status = 'issued'
         AND expires_at > CURRENT_TIMESTAMP
       RETURNING *`,
      [tokenHash, userId, companyId]
    );

    if (sessionRes.rows.length === 0) {
      auditService.logAudit({
        userId,
        action: "ATTENDANCE_VERIFICATION_REPLAY_REJECTED",
        resourceType: "attendance",
        resourceId: `session_${tokenHash.slice(0, 10)}`,
        details: { reason: "Invalid, expired, or already-consumed verification token", action: "check-out" },
        req
      });
      return res.status(403).json({
        error: "Biometric verification session is invalid, expired, or has already been used. Please capture a fresh selfie."
      });
    }

    const recordId = `${userId}_${today}`;
    const existing = await query("SELECT * FROM attendance WHERE id = $1", [recordId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "No check-in found for today." });
    }

    const rowData = existing.rows[0];
    let breaks = Array.isArray(rowData.breaks) ? [...rowData.breaks] : [];
    let totalBreakMinutes = 0;

    breaks.forEach(b => {
      if (b.start && b.end) {
        totalBreakMinutes += Math.max(0, Math.floor((new Date(b.end) - new Date(b.start)) / 60000));
      } else if (b.start && !b.end) {
        b.end = now;
        const dur = Math.max(0, Math.floor((new Date(now) - new Date(b.start)) / 60000));
        b.durationMinutes = dur;
        totalBreakMinutes += dur;
      }
    });

    let sessions = Array.isArray(rowData.sessions) ? [...rowData.sessions] : [];
    const accumulatedMins = Number(rowData.accumulated_working_minutes) || (
      sessions.filter(s => !!s.checkOut).reduce((acc, s) => acc + (Number(s.durationMinutes) || 0), 0)
    );

    let thisSessionMins = 0;
    if (rowData.check_in) {
      const checkInTime = new Date(rowData.check_in);
      const nowDate = new Date(now);
      let rawElapsed = Math.max(0, Math.floor((nowDate - checkInTime) / 60000));
      if (rawElapsed >= 1440) {
        const inMinsOfDay = checkInTime.getHours() * 60 + checkInTime.getMinutes();
        const outMinsOfDay = nowDate.getHours() * 60 + nowDate.getMinutes();
        const sameDayMins = outMinsOfDay >= inMinsOfDay ? (outMinsOfDay - inMinsOfDay) : (1440 - inMinsOfDay + outMinsOfDay);
        rawElapsed = Math.min(1440, sameDayMins);
      }
      thisSessionMins = Math.min(1440, Math.max(0, rawElapsed - totalBreakMinutes));
    }

    const totalDayMins = Math.min(1440, accumulatedMins + thisSessionMins);

    // Update open session in sessions array
    const activeIdx = sessions.findIndex(s => !s.checkOut);
    if (activeIdx !== -1) {
      sessions[activeIdx].checkOut = now;
      sessions[activeIdx].durationMinutes = thisSessionMins;
      sessions[activeIdx].breaks = breaks;
      sessions[activeIdx].checkOutLocation = location || {};
    } else {
      sessions.push({
        sessionId: `sess_${Date.now()}_${sessions.length + 1}`,
        checkIn: rowData.check_in || now,
        checkOut: now,
        durationMinutes: thisSessionMins,
        breaks,
        checkInLocation: rowData.check_in_location,
        checkOutLocation: location || {}
      });
    }

    // Preserve 'late' status if the employee checked in late
    const prevIn = rowData.check_in;
    const wasLate = rowData.status === "late" || (prevIn && (() => {
      const inD = new Date(prevIn);
      const inMins = inD.getHours() * 60 + inD.getMinutes();
      const m = String(req.user?.shift_start || "09:00").match(/(\d{1,2}):(\d{2})/);
      const sMins = m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 540;
      return inMins > (sMins + 5);
    })());

    const checkoutStatus = totalDayMins < 240 ? "half-day" : (wasLate ? "late" : "present");

    const result = await query(
      `UPDATE attendance
       SET check_out = $1,
           check_out_location = $2,
           duration_minutes = $3,
           accumulated_working_minutes = $3,
           sessions = $4,
           breaks = $5,
           status = $6,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING *`,
      [now, JSON.stringify(location || {}), totalDayMins, JSON.stringify(sessions), JSON.stringify(breaks), checkoutStatus, recordId]
    );

    const row = result.rows[0];
    const checkOutDate = row.check_out ? new Date(row.check_out) : new Date();
    const formatTime = (d) => d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : "";

    auditService.logAudit({
      userId: row.user_id,
      action: "ATTENDANCE_CLOCK_OUT",
      resourceType: "attendance",
      resourceId: row.id,
      details: { date: today, totalWorkingMinutes: totalDayMins, verificationSessionId: sessionRes.rows[0].id },
      req
    });

    res.json({
      ...row,
      id: row.id,
      userId: row.user_id,
      companyId: row.company_id,
      date: today,
      checkOut: formatTime(checkOutDate),
      checkOutTime: row.check_out || now,
      sessions,
      accumulatedWorkingMinutes: totalDayMins,
      totalWorkingMinutes: totalDayMins,
      durationMinutes: totalDayMins,
      duration_minutes: totalDayMins,
      status: "checked-out"
    });
  } catch (err) {
    console.error("checkOut error:", err);
    res.status(500).json({ error: "Check-out failed." });
  }
};

export const startBreak = async (req, res) => {
  try {
    let userId = req.user?.id || req.body.userId;
    if (typeof userId === "object" && userId !== null) {
      userId = userId.uid || userId.id;
    }
    const today = req.body.date || new Date().toISOString().split("T")[0];
    const now = new Date().toISOString();
    const { breakType = "short", reason = "break", location } = req.body;

    const recordId = `${userId}_${today}`;
    const existing = await query("SELECT * FROM attendance WHERE id = $1", [recordId]);
    if (existing.rows.length === 0 || !existing.rows[0].check_in) {
      return res.status(400).json({ error: "Cannot start a break without checking in first." });
    }
    if (existing.rows[0].check_out) {
      return res.status(400).json({ error: "Cannot start a break after checking out." });
    }

    const row = existing.rows[0];
    const breaks = Array.isArray(row.breaks) ? [...row.breaks] : [];
    if (breaks.some(b => !b.end && !b.resumeTime)) {
      return res.status(400).json({ error: "A break is already in progress." });
    }

    if (breaks.length >= 3) {
      return res.status(400).json({ error: "Maximum limit reached. An employee can only take up to 3 breaks per day." });
    }

    const normalizedReqType = String(breakType).toLowerCase();
    const isTypeAlreadyUsed = breaks.some(b => {
      const bType = String(b.breakType || b.type || "").toLowerCase();
      const isResumed = Boolean(b.end || b.resumeTime);
      if (!isResumed) return false;

      if (normalizedReqType === "short" || normalizedReqType === "break1") {
        return bType === "short" || bType === "break1";
      }
      if (normalizedReqType === "long" || normalizedReqType === "break2") {
        return bType === "long" || bType === "break2";
      }
      if (normalizedReqType === "bio" || normalizedReqType === "break3") {
        return bType === "bio" || bType === "break3";
      }
      return bType === normalizedReqType;
    });

    if (isTypeAlreadyUsed) {
      return res.status(400).json({ error: "This break has already been taken and resumed today. It has been removed from your available breaks." });
    }

    let durationSeconds = 1800;
    if (normalizedReqType === "bio" || normalizedReqType === "break3") durationSeconds = 900;
    const timerEnd = new Date(Date.now() + durationSeconds * 1000).toISOString();

    breaks.push({
      start: now,
      startTime: now,
      end: null,
      resumeTime: null,
      breakType,
      type: breakType,
      reason,
      location: location || null
    });

    const result = await query(
      `UPDATE attendance
       SET breaks = $1, status = 'on-break', updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(breaks), recordId]
    );

    const updated = result.rows[0];

    auditService.logAudit({
      userId,
      action: "ATTENDANCE_BREAK_START",
      resourceType: "attendance",
      resourceId: recordId,
      details: {
        breakNumber: breaks.length,
        breakType,
        startTime: now,
        durationMinutes: durationSeconds / 60,
        remainingBreaksAfterThis: Math.max(0, 3 - breaks.length),
        location: location || null
      },
      req
    });

    res.json({
      ...updated,
      id: updated.id,
      userId: updated.user_id,
      companyId: updated.company_id,
      date: today,
      checkInTime: updated.check_in,
      checkOutTime: updated.check_out,
      currentBreakTimerEnd: timerEnd,
      status: "on-break",
      breaks: updated.breaks
    });
  } catch (err) {
    console.error("startBreak error:", err);
    res.status(500).json({ error: "Failed to start break." });
  }
};

export const endBreak = async (req, res) => {
  try {
    let userId = req.user?.id || req.body.userId;
    if (typeof userId === "object" && userId !== null) {
      userId = userId.uid || userId.id;
    }
    const today = req.body.date || new Date().toISOString().split("T")[0];
    const now = new Date().toISOString();
    const { location } = req.body;

    const recordId = `${userId}_${today}`;
    const existing = await query("SELECT * FROM attendance WHERE id = $1", [recordId]);
    if (existing.rows.length === 0 || !existing.rows[0].check_in) {
      return res.status(400).json({ error: "No attendance record found for today." });
    }

    const row = existing.rows[0];
    const breaks = Array.isArray(row.breaks) ? [...row.breaks] : [];
    const activeIdx = breaks.findIndex(b => !b.end && !b.resumeTime);
    if (activeIdx === -1) {
      return res.status(400).json({ error: "No active break to resume from." });
    }

    const breakStart = new Date(breaks[activeIdx].start || breaks[activeIdx].startTime);
    const breakDurationMinutes = Math.max(0, Math.floor((new Date(now) - breakStart) / 60000));
    breaks[activeIdx].end = now;
    breaks[activeIdx].resumeTime = now;
    breaks[activeIdx].durationMinutes = breakDurationMinutes;
    breaks[activeIdx].duration = breakDurationMinutes;
    if (location) breaks[activeIdx].endLocation = location;

    const result = await query(
      `UPDATE attendance
       SET breaks = $1, status = 'present', updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(breaks), recordId]
    );

    const updated = result.rows[0];
    const completedBreak = breaks[activeIdx];
    const totalCompletedBreaks = breaks.filter(b => b.end || b.resumeTime).length;
    auditService.logAudit({
      userId: row.user_id,
      action: "ATTENDANCE_BREAK_RESUME",
      resourceType: "attendance",
      resourceId: recordId,
      details: {
        breakNumber: activeIdx + 1,
        breakType: completedBreak.breakType || completedBreak.type,
        startTime: completedBreak.start || completedBreak.startTime,
        resumeTime: now,
        durationMinutes: breakDurationMinutes,
        totalCompletedBreaks,
        remainingBreaks: Math.max(0, 3 - totalCompletedBreaks),
        location: location || null
      },
      req
    });

    res.json({
      ...updated,
      id: updated.id,
      userId: updated.user_id,
      companyId: updated.company_id,
      date: today,
      checkInTime: updated.check_in,
      checkOutTime: updated.check_out,
      status: "checked-in",
      breaks: updated.breaks
    });
  } catch (err) {
    console.error("endBreak error:", err);
    res.status(500).json({ error: "Failed to end break." });
  }
};

export const updateAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const callerRole = req.user?.role?.toLowerCase();
    const isAllowed = callerRole === "admin" || callerRole === "superadmin" || callerRole === "manager" || callerRole === "system admin";

    if (!isAllowed) {
      return res.status(403).json({ error: "Access forbidden. Admin or Manager role required to edit attendance records." });
    }

    const { checkIn, checkOut, status, date } = req.body;

    const result = await query(
      `UPDATE attendance
       SET check_in = COALESCE($1, check_in),
           check_out = COALESCE($2, check_out),
           status = COALESCE($3, status),
           date = COALESCE($4, date),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING *`,
      [checkIn || null, checkOut || null, status || null, date || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Attendance record not found." });
    }

    const updatedRow = result.rows[0];
    auditService.logAudit({
      userId: req.user?.id,
      action: "ATTENDANCE_EDIT",
      resourceType: "attendance",
      resourceId: id,
      details: { checkIn, checkOut, status, date, targetUserId: updatedRow.user_id },
      req
    });
    securityDetector.checkSuspiciousAction({
      userId: req.user?.id,
      action: "ATTENDANCE_EDIT",
      resourceType: "attendance",
      details: { checkIn, checkOut, status, date, targetUserId: updatedRow.user_id },
      req
    });

    res.json(updatedRow);
  } catch (err) {
    console.error("updateAttendance error:", err);
    res.status(500).json({ error: "Failed to update attendance." });
  }
};

export const deleteAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const callerRole = req.user?.role?.toLowerCase();
    const isAllowed = callerRole === "admin" || callerRole === "superadmin" || callerRole === "system admin";

    if (!isAllowed) {
      return res.status(403).json({ error: "Access forbidden. Admin role required to delete attendance records." });
    }

    const result = await query("DELETE FROM attendance WHERE id = $1 RETURNING id", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Attendance record not found." });
    }
    res.json({ message: "Attendance record deleted.", id });
  } catch (err) {
    console.error("deleteAttendance error:", err);
    res.status(500).json({ error: "Failed to delete attendance record." });
  }
};

export const getAttendanceRules = async (req, res) => {
  try {
    const { companyId } = req.query;
    const targetCompanyId = companyId || req.user?.companyId;

    if (targetCompanyId) {
      const compResult = await query("SELECT value FROM settings WHERE key = $1", [`attendance_rules_${targetCompanyId}`]);
      if (compResult.rows.length > 0) {
        const val = compResult.rows[0].value;
        return res.json({ rules: typeof val === "object" && val !== null ? (val.rules || "") : (val || "") });
      }
    }

    const result = await query("SELECT value FROM settings WHERE key = 'attendance_rules'");
    if (result.rows.length > 0) {
      const val = result.rows[0].value;
      res.json({ rules: typeof val === "object" && val !== null ? (val.rules || "") : (val || "") });
    } else {
      res.json({ rules: "" });
    }
  } catch (err) {
    console.error("getAttendanceRules error:", err);
    res.status(500).json({ error: "Failed to fetch attendance rules." });
  }
};

export const updateAttendanceRules = async (req, res) => {
  try {
    const { rules, companyId } = req.body;
    const targetCompanyId = companyId || req.user?.companyId;

    if (targetCompanyId) {
      await query(
        `INSERT INTO settings (key, value)
         VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
        [`attendance_rules_${targetCompanyId}`, JSON.stringify({ rules })]
      );
    }

    await query(
      `INSERT INTO settings (key, value)
       VALUES ('attendance_rules', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
      [JSON.stringify({ rules })]
    );

    res.json({ success: true, rules });
  } catch (err) {
    console.error("updateAttendanceRules error:", err);
    res.status(500).json({ error: "Failed to update attendance rules." });
  }
};

const ensureFaceReenrollmentTable = async () => {
  await query(`
    CREATE TABLE IF NOT EXISTS face_reenrollment_requests (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      rejection_reason TEXT,
      permission_expires_at TIMESTAMPTZ,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_face_reenroll_employee_company
    ON face_reenrollment_requests(employee_id, company_id, status, requested_at DESC);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_face_reenroll_company_status
    ON face_reenrollment_requests(company_id, status, requested_at DESC);
  `);
};
