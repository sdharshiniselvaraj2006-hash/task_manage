import React, { useState, useEffect, useCallback } from "react";
import {
  CalendarCheck,
  Table,
  Activity,
  Clock,
  RefreshCw
} from "lucide-react";
import AttendanceOverviewCards from "./AttendanceOverviewCards";
import AttendanceFilterBar from "./AttendanceFilterBar";
import EmployeeAttendanceTable from "./EmployeeAttendanceTable";
import LiveAttendancePulse from "./LiveAttendancePulse";
import RegularizationQueuePanel from "./RegularizationQueuePanel";
import EmployeeAttendanceDetailsModal from "./EmployeeAttendanceDetailsModal";
import ReviewAttendanceModal from "./ReviewAttendanceModal";
import EmployeeAttendanceDownloadModal from "./EmployeeAttendanceDownloadModal";

import {
  getAttendanceMonitoringSummary,
  getAttendanceMonitoringRecords,
  getLiveAttendanceMonitoring,
  getAttendanceAnalytics,
  reviewAttendanceRegularizationApi
} from "../../firebase";

export default function AttendanceMonitoringTab({ currentUser, showToast }) {
  // Navigation sub-tab
  const [subTab, setSubTab] = useState("records"); // "records" | "live" | "regularization"

  // Unified Daily Filter State
  const [filters, setFilters] = useState({
    range: "today",
    department: "all",
    status: "all",
    search: ""
  });

  // Department List
  const [departments, setDepartments] = useState([]);

  // Data States
  const [summary, setSummary] = useState(null);
  const [records, setRecords] = useState([]);
  const [liveData, setLiveData] = useState(null);
  const [analyticsData, setAnalyticsData] = useState(null);
  const [regularizationRequests, setRegularizationRequests] = useState([]);

  // Loading & Error States
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [errorSummary, setErrorSummary] = useState(null);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [errorRecords, setErrorRecords] = useState(null);
  const [loadingLive, setLoadingLive] = useState(false);
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(new Date().toLocaleTimeString());

  // Modal States
  const [detailsModal, setDetailsModal] = useState({ open: false, userId: null, record: null });
  const [reviewModal, setReviewModal] = useState({ open: false, record: null });
  const [downloadModal, setDownloadModal] = useState({ open: false, employee: null });

  // Load Summary
  const loadSummary = useCallback(async () => {
    setLoadingSummary(true);
    setErrorSummary(null);
    try {
      const res = await getAttendanceMonitoringSummary(filters);
      if (res) {
        setSummary(res.data || res.summary || res);
      }
    } catch (err) {
      console.error("Failed to load attendance summary:", err);
      setErrorSummary(err.message || "Failed to load attendance summary.");
    } finally {
      setLoadingSummary(false);
    }
  }, [filters]);

  // Load Records
  const loadRecords = useCallback(async () => {
    setLoadingRecords(true);
    setErrorRecords(null);
    try {
      const res = await getAttendanceMonitoringRecords(filters);
      if (res) {
        const rawRecs = res.records || res.data?.records || [];
        setRecords(rawRecs);
        const depts = res.departments || res.data?.departments || [];
        if (depts.length > 0) {
          setDepartments(depts);
        }
      }
    } catch (err) {
      console.error("Failed to load attendance records:", err);
      setErrorRecords(err.message || "Failed to fetch attendance records.");
      showToast && showToast("Failed to fetch attendance records.", "error");
    } finally {
      setLoadingRecords(false);
    }
  }, [filters, showToast]);

  // Load Live Data
  const loadLive = useCallback(async () => {
    setLoadingLive(true);
    try {
      const res = await getLiveAttendanceMonitoring();
      if (res) {
        const livePayload = {
          date: res.date || new Date().toISOString().split("T")[0],
          timestamp: res.lastRefreshedAt || res.timestamp || new Date().toISOString(),
          working: res.categories?.working || res.working || [],
          notCheckedIn: res.categories?.notCheckedIn || res.notCheckedIn || [],
          checkedOut: res.categories?.checkedOut || res.checkedOut || [],
          lateToday: res.categories?.late || res.lateToday || [],
          pendingVerification: res.categories?.pendingReview || res.pendingVerification || []
        };
        setLiveData(livePayload);
      }
    } catch (err) {
      console.error("Failed to load live attendance pulse:", err);
    } finally {
      setLoadingLive(false);
    }
  }, []);

  // Load Analytics
  const loadAnalytics = useCallback(async () => {
    setLoadingAnalytics(true);
    try {
      const res = await getAttendanceAnalytics(filters);
      if (res) {
        const rawTrends = res.dailyAttendance || res.dailyTrends || res.data?.dailyTrends || [];
        const rawDepts = res.departmentBreakdown || res.data?.departmentBreakdown || [];
        const rawHours = res.workingHoursDistribution || res.data?.workingHoursDistribution || [];
        const rawStatus = res.statusDistribution || res.data?.statusDistribution || [];
        const rawRegs = res.regularizationStats?.recent || res.regularizationRequests || res.data?.regularizationRequests || [];

        setAnalyticsData({
          dailyTrends: rawTrends,
          departmentBreakdown: rawDepts,
          workingHoursDistribution: rawHours,
          statusDistribution: rawStatus,
          regularizationStats: res.regularizationStats
        });
        setRegularizationRequests(rawRegs);
      }
    } catch (err) {
      console.error("Failed to load attendance analytics:", err);
    } finally {
      setLoadingAnalytics(false);
    }
  }, [filters]);

  // Master refresh
  const refreshAll = useCallback(() => {
    setLastRefreshed(new Date().toLocaleTimeString());
    loadSummary();
    loadRecords();
    loadLive();
    loadAnalytics();
  }, [loadSummary, loadRecords, loadLive, loadAnalytics]);

  // Initial & Filter change trigger
  useEffect(() => {
    loadSummary();
    loadRecords();
    loadAnalytics();
  }, [loadSummary, loadRecords, loadAnalytics]);

  // Live and Periodic Synchronization
  useEffect(() => {
    loadLive();
    // Auto refresh live pulse every 30s
    const timer = setInterval(() => {
      loadLive();
      loadSummary();
      loadRecords();
    }, 30000);

    const onSync = () => {
      loadSummary();
      loadRecords();
      loadLive();
    };
    window.addEventListener("focus", onSync);
    window.addEventListener("attendance-updated", onSync);

    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onSync);
      window.removeEventListener("attendance-updated", onSync);
    };
  }, [loadLive, loadSummary, loadRecords]);

  // Handlers for Regularization Approval / Rejection
  const handleApproveRegularization = async (regId, adminNote) => {
    try {
      const res = await reviewAttendanceRegularizationApi(regId, {
        action: "approve",
        adminRemarks: adminNote
      });
      if (res && res.success) {
        showToast && showToast("Regularization request approved and attendance updated.", "success");
        refreshAll();
      } else {
        throw new Error(res?.message || "Failed to approve regularization request.");
      }
    } catch (err) {
      console.error(err);
      showToast && showToast(err.message || "Failed to approve regularization.", "error");
    }
  };

  const handleRejectRegularization = async (regId, adminNote) => {
    try {
      const res = await reviewAttendanceRegularizationApi(regId, {
        action: "reject",
        adminRemarks: adminNote
      });
      if (res && res.success) {
        showToast && showToast("Regularization request rejected.", "info");
        refreshAll();
      } else {
        throw new Error(res?.message || "Failed to reject regularization request.");
      }
    } catch (err) {
      console.error(err);
      showToast && showToast(err.message || "Failed to reject regularization.", "error");
    }
  };

  return (
    <div className="space-y-6 w-full text-left">
      {/* Header Banner */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight flex items-center gap-3">
            <span className="p-2.5 rounded-2xl bg-purple-600/20 text-purple-400 border border-purple-500/30">
              <CalendarCheck className="w-6 h-6" />
            </span>
            Attendance Monitoring & Audit
          </h1>
          <p className="text-xs sm:text-sm text-zinc-400 mt-1 max-w-2xl">
            Real-time workforce tracking, shift compliance, and automated regularization review.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right hidden sm:block text-xs">
            <div className="text-zinc-400">Synchronized At</div>
            <div className="text-zinc-200 font-mono text-[11px]">{lastRefreshed}</div>
          </div>
          <button
            type="button"
            onClick={refreshAll}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold shadow-lg shadow-purple-950/40 transition-all cursor-pointer"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh All Data
          </button>
        </div>
      </div>

      {/* Overview KPI Cards */}
      <AttendanceOverviewCards
        summary={summary}
        loading={loadingSummary}
        error={errorSummary}
        onRetry={loadSummary}
        activeStatus={filters.status}
        onCardClick={(statusKey) => {
          setFilters((prev) => {
            const nextStatus = (prev.status === statusKey && statusKey !== "all") ? "all" : statusKey;
            return { ...prev, status: nextStatus };
          });
          setSubTab("records");
        }}
      />

      {/* Sub-navigation Tabs */}
      <div className="flex items-center gap-2 border-b border-zinc-800 pb-2 overflow-x-auto text-xs font-semibold">
        <button
          type="button"
          onClick={() => setSubTab("records")}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl transition-all ${
            subTab === "records"
              ? "bg-purple-600 text-white shadow-md shadow-purple-950/40"
              : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60"
          }`}
        >
          <Table className="w-4 h-4" />
          Employee Attendance Table
        </button>

        <button
          type="button"
          onClick={() => setSubTab("live")}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl transition-all relative ${
            subTab === "live"
              ? "bg-purple-600 text-white shadow-md shadow-purple-950/40"
              : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60"
          }`}
        >
          <Activity className="w-4 h-4" />
          Live Pulse Today
          {liveData?.working?.length > 0 && (
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping ml-1" />
          )}
        </button>

        <button
          type="button"
          onClick={() => setSubTab("regularization")}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl transition-all ${
            subTab === "regularization"
              ? "bg-purple-600 text-white shadow-md shadow-purple-950/40"
              : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60"
          }`}
        >
          <Clock className="w-4 h-4" />
          Regularization Queue
          {summary?.pendingRegularization > 0 && (
            <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/40">
              {summary.pendingRegularization}
            </span>
          )}
        </button>
      </div>

      {/* Filter Bar (Visible on Employee Attendance Table) */}
      {subTab === "records" && (
        <AttendanceFilterBar
          filters={filters}
          onChange={setFilters}
          departments={departments}
          onRefresh={refreshAll}
          loading={loadingRecords}
          lastRefreshed={lastRefreshed}
        />
      )}

      {/* Main Content Renderers */}
      {subTab === "records" && (
        <EmployeeAttendanceTable
          records={records}
          loading={loadingRecords}
          error={errorRecords}
          onRetry={loadRecords}
          onViewEmployee={(userId, rec) => setDetailsModal({ open: true, userId, record: rec })}
          onDownloadEmployee={(userId, rec) => setDownloadModal({ open: true, employee: rec })}
          onReviewRecord={(rec) => setReviewModal({ open: true, record: rec })}
          onRegularizeRecord={(rec) => {
            setSubTab("regularization");
          }}
        />
      )}

      {subTab === "live" && (
        <LiveAttendancePulse
          liveData={liveData}
          loading={loadingLive}
          onRefresh={loadLive}
          onViewEmployee={(userId, emp) => setDetailsModal({ open: true, userId, record: emp })}
          onReviewRecord={(rec) => setReviewModal({ open: true, record: rec })}
        />
      )}

      {subTab === "regularization" && (
        <RegularizationQueuePanel
          requests={regularizationRequests}
          loading={loadingAnalytics}
          onApprove={handleApproveRegularization}
          onReject={handleRejectRegularization}
        />
      )}

      {/* Employee Attendance Details Modal */}
      {detailsModal.open && (
        <EmployeeAttendanceDetailsModal
          userId={detailsModal.userId}
          initialRecord={detailsModal.record}
          isOpen={detailsModal.open}
          allRecords={records}
          onClose={() => setDetailsModal({ open: false, userId: null, record: null })}
          onReviewRecord={(rec) => setReviewModal({ open: true, record: rec })}
          showToast={showToast}
        />
      )}

      {/* Review Attendance Modal */}
      {reviewModal.open && (
        <ReviewAttendanceModal
          record={reviewModal.record}
          isOpen={reviewModal.open}
          onClose={() => setReviewModal({ open: false, record: null })}
          onSuccess={refreshAll}
          showToast={showToast}
        />
      )}

      {/* Individual Employee Attendance Download Modal */}
      {downloadModal.open && (
        <EmployeeAttendanceDownloadModal
          isOpen={downloadModal.open}
          employee={downloadModal.employee}
          onClose={() => setDownloadModal({ open: false, employee: null })}
          showToast={showToast}
        />
      )}
    </div>
  );
}
