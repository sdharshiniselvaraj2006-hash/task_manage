import React from 'react';
import { 
  Calendar, 
  Search, 
  RefreshCw, 
  SlidersHorizontal, 
  Building2, 
  X
} from 'lucide-react';

export default function AttendanceFilterBar({
  filters,
  onChange,
  department: propDepartment,
  setDepartment: propSetDepartment,
  status: propStatus,
  setStatus: propSetStatus,
  searchQuery: propSearchQuery,
  setSearchQuery: propSetSearchQuery,
  onRefresh,
  loading = false,
  isRefreshing = false,
  lastRefreshedAt,
  lastRefreshed,
  departments = []
}) {
  const department = filters?.department ?? propDepartment ?? "all";
  const status = filters?.status ?? propStatus ?? "all";
  const searchQuery = filters?.search ?? filters?.searchQuery ?? propSearchQuery ?? "";
  const refreshing = loading || isRefreshing;
  const refreshTimestamp = lastRefreshedAt || lastRefreshed;

  const updateFilter = (key, value) => {
    if (onChange) {
      onChange((prev) => ({
        ...prev,
        [key]: value,
        ...(key === "searchQuery" ? { search: value } : {}),
        ...(key === "search" ? { searchQuery: value } : {})
      }));
    }
  };

  const setDepartment = (val) => {
    updateFilter("department", val);
    if (propSetDepartment) propSetDepartment(val);
  };

  const setStatus = (val) => {
    updateFilter("status", val);
    if (propSetStatus) propSetStatus(val);
  };

  const setSearchQuery = (val) => {
    updateFilter("search", val);
    if (propSetSearchQuery) propSetSearchQuery(val);
  };

  const statusOptions = [
    { value: "all", label: "All Statuses" },
    { value: "Present", label: "Present" },
    { value: "working", label: "Currently Working" },
    { value: "checked_out", label: "Checked Out" },
    { value: "Late", label: "Late" },
    { value: "Absent", label: "Absent" },
    { value: "Half Day", label: "Half Day" },
    { value: "On Leave", label: "On Leave" },
    { value: "regularization", label: "Pending Regularization" },
    { value: "Holiday", label: "Holiday" },
    { value: "Weekly Off", label: "Weekly Off" },
    { value: "Pending", label: "Pending" },
    { value: "Attendance Locked", label: "Locked" }
  ];

  const hasActiveFilters = status !== "all" || department !== "all" || searchQuery !== "";
  const clearAllFilters = () => {
    setStatus("all");
    setDepartment("all");
    setSearchQuery("");
  };

  const formattedRefreshTime = refreshTimestamp
    ? (typeof refreshTimestamp === "string" && refreshTimestamp.includes(":") && !refreshTimestamp.includes("T")
        ? refreshTimestamp
        : new Date(refreshTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
    : "Just now";

  const todayDisplay = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(new Date());

  return (
    <div className="bg-bg-card p-4 sm:p-5 rounded-[24px] border border-border-card shadow-sm mb-6 space-y-4">
      {/* Top Header: Today's Attendance Overview & Sync Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-[10px] bg-purple-500/10 border border-purple-500/20 text-purple-400 flex items-center justify-center">
            <Calendar size={16} />
          </div>
          <div>
            <div className="text-xs font-bold text-text-main flex items-center gap-2">
              Today's Attendance Records
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Live Daily
              </span>
            </div>
            <div className="text-[11px] text-text-mut font-medium">{todayDisplay}</div>
          </div>
        </div>

        {/* Clear Filter & Refresh Controls */}
        <div className="flex items-center gap-2.5 ml-auto">
          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearAllFilters}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 rounded-[10px] text-xs font-semibold cursor-pointer transition-all"
              title="Clear all active filters"
            >
              <X size={13} />
              <span>Clear Filter</span>
            </button>
          )}

          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-text-mut">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>Updated: <strong className="text-text-sec">{formattedRefreshTime}</strong></span>
          </div>

          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-bg-base hover:bg-bg-base/80 border border-border-card rounded-[12px] text-xs font-bold text-text-sec hover:text-brand-primary transition-all cursor-pointer disabled:opacity-50 shadow-sm"
            title="Refresh attendance records"
          >
            <RefreshCw size={14} className={refreshing ? "animate-spin text-brand-primary" : ""} />
            <span>{refreshing ? "Refreshing..." : "Refresh"}</span>
          </button>
        </div>
      </div>

      {/* Primary Filter Controls: Search, Department, Status */}
      <div className="grid grid-cols-1 sm:grid-cols-3 md:grid-cols-12 gap-3 pt-3 border-t border-border-card/60">
        {/* Search Input */}
        <div className="sm:col-span-3 md:col-span-6 relative">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-mut" />
          <input
            type="text"
            placeholder="Search employee by name, ID, or email..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-8 py-2 bg-bg-base/40 border border-border-card rounded-[12px] text-xs text-text-main placeholder:text-text-mut outline-none focus:bg-bg-card focus:border-brand-primary transition-all font-semibold"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-text-mut hover:text-text-main p-0.5 cursor-pointer"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Department Filter */}
        <div className="sm:col-span-3 md:col-span-3 relative">
          <Building2 size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-mut pointer-events-none" />
          <select
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            className="w-full pl-9 pr-8 py-2 bg-bg-base/40 border border-border-card rounded-[12px] text-xs text-text-main outline-none focus:bg-bg-card focus:border-brand-primary transition-all font-semibold appearance-none cursor-pointer"
          >
            <option value="all" className="bg-bg-card text-text-main">All Departments</option>
            {departments.map((d) => (
              <option key={d} value={d} className="bg-bg-card text-text-main">{d}</option>
            ))}
          </select>
          <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-text-mut text-[10px]">▼</div>
        </div>

        {/* Status Filter */}
        <div className="sm:col-span-3 md:col-span-3 relative">
          <SlidersHorizontal size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-mut pointer-events-none" />
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-full pl-9 pr-8 py-2 bg-bg-base/40 border border-border-card rounded-[12px] text-xs text-text-main outline-none focus:bg-bg-card focus:border-brand-primary transition-all font-semibold appearance-none cursor-pointer"
          >
            {statusOptions.map((s) => (
              <option key={s.value} value={s.value} className="bg-bg-card text-text-main">{s.label}</option>
            ))}
          </select>
          <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-text-mut text-[10px]">▼</div>
        </div>
      </div>
    </div>
  );
}
