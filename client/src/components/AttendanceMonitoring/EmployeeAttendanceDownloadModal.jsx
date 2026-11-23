import React, { useState, useEffect } from "react";
import {
  X,
  Download,
  Calendar,
  FileSpreadsheet,
  FileText,
  User,
  Clock,
  CheckCircle2,
  CalendarRange,
  ChevronRight,
  ShieldCheck,
  AlertCircle
} from "lucide-react";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { getEmployeeAttendanceReportApi } from "../../firebase";

export default function EmployeeAttendanceDownloadModal({
  isOpen = false,
  onClose,
  employee = null,
  showToast
}) {
  const [selectedRange, setSelectedRange] = useState("this_month"); // today, this_week, this_month, custom, all
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [format, setFormat] = useState("xlsx"); // xlsx, pdf, csv
  const [loading, setLoading] = useState(false);

  // Initialize dates based on range selection
  useEffect(() => {
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];

    if (selectedRange === "today") {
      setStartDate(todayStr);
      setEndDate(todayStr);
    } else if (selectedRange === "this_week") {
      const day = now.getDay();
      const diffToMon = day === 0 ? 6 : day - 1;
      const mon = new Date(now);
      mon.setDate(now.getDate() - diffToMon);
      const sun = new Date(mon);
      sun.setDate(mon.getDate() + 6);
      setStartDate(mon.toISOString().split("T")[0]);
      setEndDate(sun.toISOString().split("T")[0]);
    } else if (selectedRange === "this_month") {
      const y = now.getFullYear();
      const m = now.getMonth();
      const first = new Date(y, m, 1);
      const last = new Date(y, m + 1, 0);
      setStartDate(first.toISOString().split("T")[0]);
      setEndDate(last.toISOString().split("T")[0]);
    } else if (selectedRange === "all") {
      setStartDate("");
      setEndDate("");
    }
  }, [selectedRange]);

  if (!isOpen || !employee) return null;

  const empName = employee.employeeName || employee.name || employee.user_name || "Employee";
  const empId = employee.empId || employee.employeeId || employee.userId?.slice(-6) || "EMP";
  const empDept = employee.department || "General";
  const empDesignation = employee.designation || "Staff";
  const targetUserId = employee.userId || employee.id || employee.user_id;

  const handleDownload = async () => {
    if (!targetUserId) {
      showToast && showToast("Error: Employee ID not identified.", "error");
      return;
    }

    if (selectedRange === "custom" && (!startDate || !endDate)) {
      showToast && showToast("Please select both start and end dates.", "warning");
      return;
    }

    setLoading(true);
    try {
      const queryParams = {
        range: selectedRange
      };
      if (selectedRange !== "all") {
        if (startDate) queryParams.startDate = startDate;
        if (endDate) queryParams.endDate = endDate;
      }

      const res = await getEmployeeAttendanceReportApi(targetUserId, queryParams);
      if (!res || !res.records) {
        throw new Error(res?.error || "Failed to retrieve employee attendance records.");
      }

      const reportEmp = res.employee || {
        employeeName: empName,
        employeeId: empId,
        department: empDept,
        designation: empDesignation
      };
      const summary = res.summary || {};
      const records = res.records || [];

      if (records.length === 0) {
        showToast && showToast(`No attendance records found for ${empName} in the selected period.`, "info");
      }

      const safeEmpName = empName.replace(/\s+/g, "_");
      const rangeLabel = selectedRange === "all" ? "All_Records" : `${startDate}_${endDate}`;
      const filenameBase = `Attendance_Report_${safeEmpName}_${rangeLabel}`;

      // 1. Export Excel (.xlsx)
      if (format === "xlsx") {
        const aoaData = [
          ["INDIVIDUAL EMPLOYEE ATTENDANCE REPORT"],
          ["Generated On", new Date().toLocaleString()],
          ["Reporting Period", selectedRange === "all" ? "All Available Records" : `${startDate} to ${endDate}`],
          [],
          ["EMPLOYEE INFORMATION"],
          ["Employee Name", reportEmp.employeeName || empName],
          ["Employee ID", reportEmp.employeeId || empId],
          ["Department", reportEmp.department || empDept],
          ["Designation", reportEmp.designation || empDesignation],
          [],
          ["MONTHLY / SELECTED PERIOD SUMMARY"],
          ["Total Present Days", summary.totalPresentDays ?? 0],
          ["Total Absent Days", summary.totalAbsentDays ?? 0],
          ["Total Leave Days", summary.totalLeaveDays ?? 0],
          ["Total Late Arrivals", summary.totalLateArrivals ?? 0],
          ["Total Break Hours", summary.totalBreakHours || summary.totalBreakDuration || "00h 00m"],
          ["Total Working Hours", summary.totalWorkingHours || summary.totalNetWorkingHours || "00h 00m"],
          ["Average Daily Working Hours", summary.averageDailyWorkingHours || "00h 00m"],
          [],
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
          ]
        ];

        records.forEach((r) => {
          aoaData.push([
            r.attendanceDate || r.date || "",
            r.checkInTime || "--",
            r.checkInLocation || "GPS unavailable",
            r.checkInGpsVerification || "GPS unavailable",
            r.break1Start || "—",
            r.break1End || "—",
            r.break1Duration || "Not Taken",
            r.break2Start || "—",
            r.break2End || "—",
            r.break2Duration || "Not Taken",
            r.break3Start || "—",
            r.break3End || "—",
            r.break3Duration || "Not Taken",
            r.additionalBreaks || "None",
            r.totalBreakDuration || "00h 00m",
            r.checkOutTime || "--",
            r.checkOutLocation || "GPS unavailable",
            r.checkOutGpsVerification || "GPS unavailable",
            r.totalAttendanceDuration || "00h 00m",
            r.netWorkingHours || "00h 00m",
            r.lateArrival || "0m",
            r.earlyDeparture || "0m",
            r.attendanceStatus || "Present"
          ]);
        });

        const ws = XLSX.utils.aoa_to_sheet(aoaData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Attendance Report");
        XLSX.writeFile(wb, `${filenameBase}.xlsx`);

        showToast && showToast(`Excel attendance report downloaded for ${empName}!`, "success");
      }

      // 2. Export CSV (.csv)
      else if (format === "csv") {
        const escapeCsv = (val) => {
          if (val == null) return '""';
          const str = String(val).replace(/"/g, '""');
          return `"${str}"`;
        };

        const periodText = selectedRange === "all" ? "All Available Records" : `${startDate} to ${endDate}`;

        const csvLines = [
          `"INDIVIDUAL EMPLOYEE ATTENDANCE REPORT"`,
          `"Generated On",${escapeCsv(new Date().toLocaleString())}`,
          `"Reporting Period",${escapeCsv(periodText)}`,
          `""`,
          `"EMPLOYEE INFORMATION"`,
          `"Employee Name",${escapeCsv(reportEmp.employeeName || empName)}`,
          `"Employee ID",${escapeCsv(reportEmp.employeeId || empId)}`,
          `"Department",${escapeCsv(reportEmp.department || empDept)}`,
          `"Designation",${escapeCsv(reportEmp.designation || empDesignation)}`,
          `""`,
          `"MONTHLY / SELECTED PERIOD SUMMARY"`,
          `"Total Present Days",${summary.totalPresentDays ?? 0}`,
          `"Total Absent Days",${summary.totalAbsentDays ?? 0}`,
          `"Total Leave Days",${summary.totalLeaveDays ?? 0}`,
          `"Total Late Arrivals",${summary.totalLateArrivals ?? 0}`,
          `"Total Break Hours",${escapeCsv(summary.totalBreakHours || summary.totalBreakDuration || "00h 00m")}`,
          `"Total Working Hours",${escapeCsv(summary.totalWorkingHours || summary.totalNetWorkingHours || "00h 00m")}`,
          `"Average Daily Working Hours",${escapeCsv(summary.averageDailyWorkingHours || "00h 00m")}`,
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

        records.forEach((r) => {
          csvLines.push([
            r.attendanceDate || r.date || "",
            r.checkInTime || "--",
            r.checkInLocation || "GPS unavailable",
            r.checkInGpsVerification || "GPS unavailable",
            r.break1Start || "—",
            r.break1End || "—",
            r.break1Duration || "Not Taken",
            r.break2Start || "—",
            r.break2End || "—",
            r.break2Duration || "Not Taken",
            r.break3Start || "—",
            r.break3End || "—",
            r.break3Duration || "Not Taken",
            r.additionalBreaks || "None",
            r.totalBreakDuration || "00h 00m",
            r.checkOutTime || "--",
            r.checkOutLocation || "GPS unavailable",
            r.checkOutGpsVerification || "GPS unavailable",
            r.totalAttendanceDuration || "00h 00m",
            r.netWorkingHours || "00h 00m",
            r.lateArrival || "0m",
            r.earlyDeparture || "0m",
            r.attendanceStatus || "Present"
          ].map(escapeCsv).join(","));
        });

        const blob = new Blob([csvLines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `${filenameBase}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        showToast && showToast(`CSV attendance report downloaded for ${empName}!`, "success");
      }

      // 3. Export PDF (.pdf)
      else if (format === "pdf") {
        const doc = new jsPDF("landscape", "pt", "a4");

        // Header Title
        doc.setFontSize(16);
        doc.setTextColor(30, 27, 75); // Indigo
        doc.text("Zuna HRMS - Individual Employee Attendance Report", 40, 38);

        // Subtitle
        doc.setFontSize(9);
        doc.setTextColor(100, 116, 139);
        const periodStr = selectedRange === "all" ? "All Available Records" : `${startDate} to ${endDate}`;
        doc.text(`Generated On: ${new Date().toLocaleString()} | Reporting Period: ${periodStr}`, 40, 52);

        // Employee Info & Summary Card Box
        doc.setFillColor(248, 250, 252);
        doc.setDrawColor(226, 232, 240);
        doc.roundedRect(40, 62, 762, 54, 6, 6, "FD");

        doc.setFontSize(9);
        doc.setTextColor(15, 23, 42);
        doc.text(`Employee Name: ${reportEmp.employeeName || empName}`, 50, 78);
        doc.text(`Employee ID: ${reportEmp.employeeId || empId}`, 250, 78);
        doc.text(`Department: ${reportEmp.department || empDept}`, 430, 78);
        doc.text(`Designation: ${reportEmp.designation || empDesignation}`, 610, 78);

        doc.setFontSize(8.5);
        doc.setTextColor(51, 65, 85);
        doc.text(`Present Days: ${summary.totalPresentDays ?? 0} | Absent Days: ${summary.totalAbsentDays ?? 0} | Leave Days: ${summary.totalLeaveDays ?? 0} | Late Arrivals: ${summary.totalLateArrivals ?? 0}`, 50, 98);
        doc.text(`Total Break Hours: ${summary.totalBreakHours || summary.totalBreakDuration || "00h 00m"} | Total Work Hours: ${summary.totalWorkingHours || summary.totalNetWorkingHours || "00h 00m"} | Daily Avg: ${summary.averageDailyWorkingHours || "00h 00m"}`, 430, 98);

        // Daily Records Table
        const tableBody = records.map((r) => [
          r.attendanceDate || r.date || "",
          r.checkInTime || "--",
          r.checkInLocation || "GPS unavailable",
          r.checkInGpsVerification || "N/A",
          r.break1Duration || "Not Taken",
          r.break2Duration || "Not Taken",
          r.break3Duration || "Not Taken",
          r.totalBreakDuration || "00h 00m",
          r.checkOutTime || "--",
          r.checkOutLocation || "GPS unavailable",
          r.totalAttendanceDuration || "00h 00m",
          r.netWorkingHours || "00h 00m",
          r.lateArrival || "0m",
          r.earlyDeparture || "0m",
          r.attendanceStatus || "Present"
        ]);

        autoTable(doc, {
          startY: 124,
          head: [
            [
              "Date",
              "Check In",
              "In Location",
              "In GPS",
              "Break 1",
              "Break 2",
              "Break 3",
              "Total Brk",
              "Check Out",
              "Out Location",
              "Total Att.",
              "Net Hours",
              "Late",
              "Early",
              "Status"
            ]
          ],
          body: tableBody,
          theme: "grid",
          styles: {
            fontSize: 7,
            cellPadding: 3.5,
            textColor: [30, 41, 59]
          },
          headStyles: {
            fillColor: [79, 70, 229],
            textColor: [255, 255, 255],
            fontStyle: "bold"
          },
          columnStyles: {
            0: { cellWidth: 50 },
            1: { cellWidth: 44 },
            2: { cellWidth: 68 },
            3: { cellWidth: 42 },
            4: { cellWidth: 44 },
            5: { cellWidth: 44 },
            6: { cellWidth: 44 },
            7: { cellWidth: 46 },
            8: { cellWidth: 44 },
            9: { cellWidth: 68 },
            10: { cellWidth: 46 },
            11: { cellWidth: 48, fontStyle: "bold" },
            12: { cellWidth: 32 },
            13: { cellWidth: 32 },
            14: { cellWidth: 48 }
          }
        });

        doc.save(`${filenameBase}.pdf`);
        showToast && showToast(`PDF attendance report downloaded for ${empName}!`, "success");
      }

      onClose && onClose();
    } catch (err) {
      console.error("Download error:", err);
      showToast && showToast(err.message || "Failed to download attendance report.", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-150">
      <div className="bg-[#12131A] border border-purple-500/40 rounded-2xl w-full max-w-lg shadow-2xl p-6 space-y-5 text-left">
        {/* Modal Header */}
        <div className="flex items-center justify-between pb-3.5 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-purple-600/20 text-purple-400 border border-purple-500/30">
              <Download className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-base font-bold text-white">Download Employee Attendance</h4>
              <p className="text-[11px] text-zinc-400">Export verified records for this employee only.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Selected Employee Card */}
        <div className="p-3 rounded-xl bg-purple-950/20 border border-purple-500/30 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-purple-600 to-indigo-600 flex items-center justify-center text-white text-sm font-bold uppercase shrink-0">
            {empName.charAt(0)}
          </div>
          <div className="truncate flex-1">
            <div className="flex items-center gap-2">
              <span className="font-bold text-white text-sm">{empName}</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-purple-300 border border-purple-500/30">
                #{empId}
              </span>
            </div>
            <div className="text-[11px] text-zinc-400 mt-0.5">
              <span>{empDept}</span>
              <span className="mx-1.5">•</span>
              <span>{empDesignation}</span>
            </div>
          </div>
        </div>

        {/* Date Range Selection (Pills) */}
        <div className="space-y-2">
          <label className="text-[11px] font-semibold text-zinc-300 block uppercase tracking-wider">
            Select Date Range
          </label>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
            {[
              { id: "today", label: "Today" },
              { id: "this_week", label: "This Week" },
              { id: "this_month", label: "This Month" },
              { id: "custom", label: "Custom Range" },
              { id: "all", label: "All Records" }
            ].map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelectedRange(r.id)}
                className={`px-2.5 py-2 rounded-xl text-xs font-semibold transition-all cursor-pointer text-center ${
                  selectedRange === r.id
                    ? "bg-purple-600 text-white shadow-md shadow-purple-950/40 border border-purple-500"
                    : "bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          {/* Custom Date Range Pickers (shown when custom is selected) */}
          {selectedRange === "custom" && (
            <div className="grid grid-cols-2 gap-3 pt-2 animate-in fade-in duration-150">
              <div>
                <span className="text-[10px] text-zinc-400 block mb-1">From (Start Date)</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-700/80 rounded-xl px-3 py-2 text-zinc-200 text-xs focus:outline-none focus:border-purple-500 font-mono"
                />
              </div>
              <div>
                <span className="text-[10px] text-zinc-400 block mb-1">To (End Date)</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-700/80 rounded-xl px-3 py-2 text-zinc-200 text-xs focus:outline-none focus:border-purple-500 font-mono"
                />
              </div>
            </div>
          )}

          {selectedRange !== "custom" && selectedRange !== "all" && (
            <div className="text-[11px] text-zinc-400 font-mono flex items-center gap-1.5 pt-1">
              <Calendar className="w-3.5 h-3.5 text-purple-400" />
              <span>Range: {startDate} to {endDate}</span>
            </div>
          )}

          {selectedRange === "all" && (
            <div className="text-[11px] text-amber-400/90 flex items-center gap-1.5 pt-1">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span>All available recorded shifts and history will be downloaded.</span>
            </div>
          )}
        </div>

        {/* Format Selection */}
        <div className="space-y-2">
          <label className="text-[11px] font-semibold text-zinc-300 block uppercase tracking-wider">
            Select Export Format
          </label>
          <div className="grid grid-cols-3 gap-2.5">
            <button
              type="button"
              onClick={() => setFormat("xlsx")}
              className={`flex flex-col items-center justify-center p-3 rounded-xl border text-center transition-all cursor-pointer ${
                format === "xlsx"
                  ? "bg-purple-600/20 border-purple-500 text-purple-200 font-bold shadow-md shadow-purple-950/40"
                  : "bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
              }`}
            >
              <FileSpreadsheet className="w-5 h-5 mb-1 text-emerald-400" />
              <span className="text-xs">Excel (.xlsx)</span>
            </button>

            <button
              type="button"
              onClick={() => setFormat("pdf")}
              className={`flex flex-col items-center justify-center p-3 rounded-xl border text-center transition-all cursor-pointer ${
                format === "pdf"
                  ? "bg-purple-600/20 border-purple-500 text-purple-200 font-bold shadow-md shadow-purple-950/40"
                  : "bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
              }`}
            >
              <FileText className="w-5 h-5 mb-1 text-rose-400" />
              <span className="text-xs">PDF (.pdf)</span>
            </button>

            <button
              type="button"
              onClick={() => setFormat("csv")}
              className={`flex flex-col items-center justify-center p-3 rounded-xl border text-center transition-all cursor-pointer ${
                format === "csv"
                  ? "bg-purple-600/20 border-purple-500 text-purple-200 font-bold shadow-md shadow-purple-950/40"
                  : "bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
              }`}
            >
              <FileText className="w-5 h-5 mb-1 text-cyan-400" />
              <span className="text-xs">CSV (.csv)</span>
            </button>
          </div>
        </div>

        {/* Modal Actions */}
        <div className="flex items-center justify-between pt-3 border-t border-zinc-800 text-xs">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            Cancel
          </button>

          <button
            type="button"
            disabled={loading}
            onClick={handleDownload}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold bg-purple-600 hover:bg-purple-500 text-white transition-all shadow-lg shadow-purple-950/40 cursor-pointer disabled:opacity-50"
          >
            {loading ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                <span>Generating Report...</span>
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                <span>Download Report</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
