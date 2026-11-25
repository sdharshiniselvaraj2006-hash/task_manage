import React, { useState } from 'react';
import { 
  Calendar, 
  Search, 
  RefreshCw, 
  SlidersHorizontal, 
  Building2, 
  CheckCircle2, 
  X,
  Clock
} from 'lucide-react';
import { formatDisplayDate } from '../../utils/dateUtils';

export default function AttendanceFilterBar({
  filters,
  onChange,
  filterType: propFilterType,
  setFilterType: propSetFilterType,
  startDate: propStartDate,
  setStartDate: propSetStartDate,
  endDate: propEndDate,
  setEndDate: propSetEndDate,
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
  const [showCustomRange, setShowCustomRange] = useState(false);

  // Unified resolution of filter values
  const filterType = filters?.filterType || filters?.range || propFilterType || "today";
  const startDate = filters?.startDate ?? propStartDate ?? "";
  const endDate = filters?.endDate ?? propEndDate ?? "";
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
        // Sync filterType and range
        ...(key === "filterType" ? { range: value } : {}),
        ...(key === "range" ? { filterType: value } : {}),
        // Sync search
        ...(key === "searchQuery" ? { search: value } : {}),
        ...(key === "search" ? { searchQuery: value } : {})
      }));
    }
  };

  const setFilterType = (type) => {
    updateFilter("filterType", type);
    if (propSetFilterType) propSetFilterType(type);
  };

  const setStartDate = (val) => {
    updateFilter("startDate", val);
    if (propSetStartDate) propSetStartDate(val);
  };

  const setEndDate = (val) => {
    updateFilter("endDate", val);
    if (propSetEndDate) propSetEndDate(val);
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

  const filterOptions = [
    { id: "today", label: "Today" },
    { id: "yesterday", label: "Yesterday" },
    { id: "this_week", label: "This Week" },
    { id: "this_month", label: "This Month" },
    { id: "custom", label: "Custom Range" }
  ];

  const statusOptions = [
    { value: "all", label: "All Statuses" },
    { value: "Present", label: "Present" },
    { value: "working", label: "Currently Working" },
    { value: "checked_out", label: "Checked Out" },
    { value: "Late", label: "Late" },
    { value: "Absent", label: "Absent" },
    { value: "Half Day", label: "Half Day" },
    { value: "On Leave", label: "On Leave" },
    { value: "Holiday", label: "Holiday" },
    { value: "Weekly Off", label: "Weekly Off" },
    { value: "Pending", label: "Pending" },
    { value: "Attendance Locked", label: "Locked" }
  ];

  const handleSelectFilterType = (type) => {
    setFilterType(type);
    if (type === "custom") {
      setShowCustomRange(true);
    } else {
      setShowCustomRange(false);
    }
  };

  const formattedRefreshTime = refreshTimestamp
    ? (typeof refreshTimestamp === "string" && refreshTimestamp.includes(":") && !refreshTimestamp.includes("T")
        ? refreshTimestamp
        : new Date(refreshTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
    : "Just now";

  return (
    <div className="bg-bg-card p-4 sm:p-5 rounded-[24px] border border-border-card shadow-sm mb-6 space-y-4">
      {/* Top Filter Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Quick Range Pills */}
        <div className="flex items-center gap-1.5 p-1 bg-bg-base/60 rounded-[14px] border border-border-card overflow-x-auto max-w-full">
          {filterOptions.map((opt) => (
            <button
              key={opt.id}
              onClick={() => handleSelectFilterType(opt.id)}
              className={`px-3 py-1.5 rounded-[10px] text-xs font-bold transition-all whitespace-nowrap cursor-pointer ${
                filterType === opt.id
                  ? "bg-brand-primary text-white shadow-sm shadow-brand-primary/20"
                  : "text-text-sec hover:text-text-main hover:bg-bg-card"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Refresh & Last Updated Timestamp */}
        <div className="flex items-center gap-3 ml-auto">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-text-mut">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>Updated: <strong className="text-text-sec">{formattedRefreshTime}</strong></span>
          </div>

          <button
            onClick={onRefresh}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-bg-base hover:bg-bg-base/80 border border-border-card rounded-[12px] text-xs font-bold text-text-sec hover:text-brand-primary transition-all cursor-pointer disabled:opacity-50 shadow-sm"
            title="Refresh attendance records"
          >
            <RefreshCw size={14} className={isRefreshing ? "animate-spin text-brand-primary" : ""} />
            <span>{isRefreshing ? "Refreshing..." : "Refresh"}</span>
          </button>
        </div>
      </div>

      {/* Custom Date Range Popover/Inputs */}
      {showCustomRange && (
        <div className="p-3.5 bg-bg-base/40 rounded-[16px] border border-border-card flex flex-wrap items-center gap-3 animate-fade-in text-xs">
          <span className="font-extrabold text-text-mut uppercase text-[10px]">Select Date Range:</span>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="px-3 py-1.5 bg-bg-card border border-border-card rounded-[10px] text-text-main outline-none focus:border-brand-primary"
            />
            <span className="text-text-mut font-bold">to</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="px-3 py-1.5 bg-bg-card border border-border-card rounded-[10px] text-text-main outline-none focus:border-brand-primary"
            />
          </div>
          <button
            onClick={() => setShowCustomRange(false)}
            className="text-text-mut hover:text-text-main ml-auto p-1 cursor-pointer"
            title="Close custom picker"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Secondary Filter Bar: Search, Department, Status */}
      <div className="grid grid-cols-1 sm:grid-cols-3 md:grid-cols-12 gap-3 pt-1 border-t border-border-card/60">
        {/* Search Input */}
        <div className="sm:col-span-3 md:col-span-5 relative">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-mut" />
          <input
            type="text"
            placeholder="Search employee by name, ID, or email..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3.5 py-2 bg-bg-base/40 border border-border-card rounded-[12px] text-xs text-text-main placeholder:text-text-mut outline-none focus:bg-bg-card focus:border-brand-primary transition-all font-semibold"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-text-mut hover:text-text-main p-0.5"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Department Filter */}
        <div className="sm:col-span-3 md:col-span-4 relative">
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
