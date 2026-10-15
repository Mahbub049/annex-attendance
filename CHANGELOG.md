# v1.4.0 — Faster attendance workflow

- Automatically scroll the Annex webpage to its manual Submit control after a successful fill (fallback to table bottom).
- Correct individual period filling to always use No. of Class = 1; identical combined periods use the group count.
- Green circled date and period ticks with partial completion, per-course session progress, persisted across manual/automatic Annex refresh.
- Distinguish on-screen filled progress from confirmed successful submissions; only a fresh Annex confirmation promotes to Submitted.
- Fill Next skips locally marked sessions after refresh.

# Changelog

## 1.3.0 — Seamless next-date attendance
- Remember drawer open/closed state, teacher-specific Intake, Section, Course, date filters, expanded periods, last filled session and scroll position while the Annex tab remains open.
- Restore the saved course and reload its Marks Portal attendance after full Annex navigation or manual browser refresh. State is stored privately in extension per-tab session storage.
- Detect newly displayed Annex success confirmation after the teacher manually clicks Submit; refresh Annex automatically only after that fresh success signal, never on the click alone.
- Provide an always-available Refresh button next to Annex form Rescan if Annex does not show a detectable success message.
- Allow users to turn automatic post-success refresh off, without changing the manual submission policy.
- Close drawer on ordinary outside clicks, but not on Annex Submit; remember closed state across refresh.
- Prevent extension dropdowns from being mistaken for Annex form controls and disable attendance fill buttons during a running fill operation.
- Keep all Annex submissions manual; no Annex submission code or API call added.

## 1.2.0
- Full premium UI redesign: modern SaaS drawer, refined spacing, typography, surfaces, and micro-interactions.
- Rebuilt attendance sessions as professional cards with date blocks, compact status, and clearer primary actions.
- Replaced the ambiguous period dropdown with an explicit Period-wise options accordion and chevron.
- Added clearer custom select affordances for Intake, Section, and Course.
- Moved technical activity output into a collapsible Activity log to reduce visual clutter.
- Kept all login, server-fetching, Annex filling, and manual-submit behavior unchanged.

## 1.1.0
- Premium UI refresh with improved typography, spacing, color system, larger controls, and clearer hierarchy.
- More recognizable attendance date groups and period dropdown area.
- Clearer action button labels such as Fill Period, Fill all periods together, and Fill next attendance.
- Professional login layout and improved teacher panel presentation.

1.0.0

- Removed Excel/CSV upload workflow and parser dependencies.
- Added Marks Portal teacher login using the existing server authentication API.
- Added secure background-service-worker API bridge and server token storage.
- Added Intake → Section → Course selectors sourced from the teacher's active courses.
- Added direct server-side attendance loading.
- Added optional From/To attendance date filter.
- Added listwise date/period attendance view with present/absent counts.
- Added per-period Fill action.
- Added Fill Next Attendance.
- Added grouped same-date periods and Fill N periods when attendance is identical.
- Preserved manual Annex submission only; no auto-submit action exists.

## 1.0.1
- Improved login error reporting when the deployed Marks Portal server rejects extension-origin requests.
- No automatic Annex submission behavior was added.
