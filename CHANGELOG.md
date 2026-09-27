# Changelog

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
