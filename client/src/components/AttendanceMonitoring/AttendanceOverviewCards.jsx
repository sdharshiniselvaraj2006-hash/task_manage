import React from 'react';
import { 
  Users, 
  CheckCircle2, 
  XCircle, 
  ClockAlert, 
  Briefcase, 
  LogOut, 
  CalendarOff, 
  FileClock,
  AlertTriangle,
  RefreshCw
} from 'lucide-react';

export default function AttendanceOverviewCards({
  summary = {},
  loading = false,
  error = null,
  onRetry,
  onCardClick,
  activeStatus = "all"
}) {
  const s = summary || {};
  const isLoaded = !loading && !error && summary !== null;

  const cards = [
    {
      id: "total",
      statusKey: "all",
      label: "Total Employees",
      value: isLoaded ? (s.totalEmployees ?? 0) : "--",
      icon: Users,
      color: "text-blue-500",
      bgColor: "bg-blue-500/10",
      borderColor: "border-blue-500/20",
      subLabel: "Active workforce"
    },
    {
      id: "present",
      statusKey: "Present",
      label: "Present Employees",
      value: isLoaded ? (s.presentEmployees ?? 0) : "--",
      icon: CheckCircle2,
      color: "text-emerald-500",
      bgColor: "bg-emerald-500/10",
      borderColor: "border-emerald-500/20",
      subLabel: isLoaded && s.totalEmployees ? `${Math.round(((s.presentEmployees || 0) / s.totalEmployees) * 100)}% attendance rate` : "Logged check-in"
    },
    {
      id: "absent",
      statusKey: "Absent",
      label: "Absent Employees",
      value: isLoaded ? (s.absentEmployees ?? 0) : "--",
      icon: XCircle,
      color: "text-rose-500",
      bgColor: "bg-rose-500/10",
      borderColor: "border-rose-500/20",
      subLabel: "No check-in recorded"
    },
    {
      id: "late",
      statusKey: "Late",
      label: "Late Arrivals",
      value: isLoaded ? (s.lateArrivals ?? 0) : "--",
      icon: ClockAlert,
      color: "text-amber-500",
      bgColor: "bg-amber-500/10",
      borderColor: "border-amber-500/20",
      subLabel: "Past shift start"
    },
    {
      id: "working",
      statusKey: "working",
      label: "Currently Working",
      value: isLoaded ? (s.currentlyWorking ?? 0) : "--",
      icon: Briefcase,
      color: "text-purple-500",
      bgColor: "bg-purple-500/10",
      borderColor: "border-purple-500/20",
      subLabel: "Active shift session"
    },
    {
      id: "checkout",
      statusKey: "checked_out",
      label: "Checked Out",
      value: isLoaded ? (s.checkedOut ?? 0) : "--",
      icon: LogOut,
      color: "text-indigo-500",
      bgColor: "bg-indigo-500/10",
      borderColor: "border-indigo-500/20",
      subLabel: "Shift completed"
    },
    {
      id: "leave",
      statusKey: "On Leave",
      label: "Employees on Leave",
      value: isLoaded ? (s.onLeave ?? 0) : "--",
      icon: CalendarOff,
      color: "text-cyan-500",
      bgColor: "bg-cyan-500/10",
      borderColor: "border-cyan-500/20",
      subLabel: "Approved time off"
    },
    {
      id: "regularization",
      statusKey: "regularization",
      label: "Pending Regularization",
      value: isLoaded ? (s.pendingRegularization ?? 0) : "--",
      icon: FileClock,
      color: "text-amber-400",
      bgColor: "bg-amber-400/10",
      borderColor: "border-amber-400/20",
      subLabel: "Awaiting review"
    }
  ];

  return (
    <div className="space-y-3 mb-6">
      {error && (
        <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-300 flex items-center justify-between text-xs font-medium">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>Unable to load attendance overview metrics: {typeof error === "string" ? error : (error.message || "Request failed")}</span>
          </div>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border border-rose-500/40 text-xs font-semibold cursor-pointer transition-all"
            >
              <RefreshCw className="w-3 h-3" />
              Retry Metrics
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-4 gap-4">
        {cards.map((c) => {
          const Icon = c.icon;
          const isSelected = activeStatus
            ? (activeStatus.toLowerCase() === c.statusKey.toLowerCase() || (c.id === "total" && (activeStatus === "all" || !activeStatus)))
            : c.id === "total";

          return (
            <div
              key={c.id}
              onClick={() => onCardClick && onCardClick(c.statusKey, c.id)}
              className={`bg-bg-card p-4 sm:p-5 rounded-[20px] border shadow-sm hover:shadow-md transition-all flex flex-col justify-between cursor-pointer group ${
                isSelected
                  ? "border-purple-500/80 ring-2 ring-purple-500/30 bg-purple-950/10 shadow-purple-950/20"
                  : `${c.borderColor} hover:border-zinc-700`
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-1.5 min-w-0">
                  {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-purple-400 shrink-0 animate-pulse" />}
                  <span className={`text-[10px] sm:text-xs font-bold uppercase tracking-wider truncate transition-colors ${
                    isSelected ? "text-purple-300" : "text-text-sec group-hover:text-text-main"
                  }`}>
                    {c.label}
                  </span>
                </div>
                <div className={`w-8 h-8 rounded-[10px] ${c.bgColor} ${c.color} flex items-center justify-center flex-shrink-0 group-hover:scale-105 transition-transform`}>
                  <Icon size={18} />
                </div>
              </div>

              <div>
                {loading ? (
                  <div className="h-8 w-16 bg-slate-700/30 animate-pulse rounded my-1" />
                ) : (
                  <div className="text-2xl sm:text-3xl font-black text-text-main tracking-tight">
                    {c.value}
                  </div>
                )}
                <span className="text-[10px] font-semibold text-text-mut mt-1 block truncate">
                  {c.subLabel}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
