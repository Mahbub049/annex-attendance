# BUBT Annex Attendance Assistant — v1.3.0

This build replaces the old Excel-upload demo with a server-connected workflow.

## What changed

- Uses the **same Marks/Course Portal server and teacher login**.
- No `.xlsx` or `.csv` upload is used anywhere.
- After login, the teacher selects **Intake → Section → Course**.
- The extension reads that course's saved attendance directly from the protected Marks Portal attendance API.
- Optional **From / To** date filters limit the attendance list. Leave both blank to show all saved attendance.
- Every period has its own **Fill** button.
- **Fill Next Attendance** advances through the currently visible date/period list.
- Multiple periods on the same date are grouped under one date row.
  - If their attendance is identical, **Fill N periods** fills them together by setting Annex **No. of Class = N** and applying the shared attendance.
  - If the attendance differs, combined fill is disabled and each period must be filled individually.
- The extension **never submits attendance**. The teacher must review the Annex form and click Annex Submit manually.

## Data/API flow

1. Extension login → `POST /api/auth/login`
2. Existing teacher token is stored in extension storage and validated through `GET /api/auth/profile`.
3. Teacher courses → `GET /api/courses?archived=false`
4. Attendance sheet → `GET /api/attendance/sheet?courseId=...`
5. Content script selects the matching Annex Course, Intake, Section, Date and No. of Class, then changes only the visible student attendance checkboxes.

All API calls are performed by the extension background service worker. The Annex page does not receive the teacher password or JWT.

## Server changes

**None required for the supplied Course Portal server version.** It already has all required protected endpoints and returns course intake/section plus period-wise attendance matrix data.

The extension is configured to use the same production API found in the supplied Course Portal client:

`https://course-management-server-1l1s.onrender.com/api`

## Install / test

1. Extract this zip to a folder.
2. Open `chrome://extensions/` or `edge://extensions/`.
3. Turn on **Developer mode**.
4. Choose **Load unpacked** and select the extracted extension folder.
5. Open BUBT Annex → **New Attendance**.
6. Open **Attendance Assistant**.
7. Sign in with your Marks Portal teacher account.
8. Select Intake, Section and Course.
9. Optionally select From/To dates.
10. Click any period's **Fill** button, a same-attendance group's **Fill N periods** button, or **Fill Next Attendance**.
11. Verify the Annex form and manually click Annex Submit.

## Safety rule

There is no code that clicks, invokes, or searches for an Annex Submit/Save button. Login form submission is internal to the extension only.


## UI refresh (v1.1.0)
This version updates the extension interface with a more premium teacher-friendly design, clearer dropdown grouping for multiple periods, and more descriptive button labels.


## Premium UI (v1.2.0)
This release completely redesigns the extension drawer and attendance session controls while preserving the same secure Marks Portal server workflow and manual Annex submit behavior.


## Seamless attendance workflow (v1.3.0)

1. Install or **Reload** the extension in `chrome://extensions/` after replacing the extracted folder. Refresh the Annex tab once after updating the extension.
2. On Annex **New Attendance**, open the Attendance Assistant and choose Intake, Section, and Course as usual.
3. Fill an attendance date in Annex using the assistant and check the student checkboxes.
4. **Click Annex Submit yourself.** The assistant does not submit or bypass any Annex confirmation.
5. If Annex displays a **new successful attendance-submission message**, the assistant automatically reloads the Annex page. After reload, the assistant reappears open with the previous course, filters and attendance list already selected (server loading may take a moment).
6. Choose the next saved attendance date and fill again. Your last filled date and expanded period rows remain remembered.
7. If Annex saves data but does not provide a new detectable on-page success confirmation, click **↻ Refresh** beside **Rescan** to reload Annex and restore the same workspace. Do not refresh before Annex confirms the record was saved.
8. You can switch off **Ready for the next date** if you prefer to control refresh manually.

Clicking the extension **×** or elsewhere on Annex (other than its Submit button) closes the drawer; clicking the launcher reopens it. If you deliberately close the drawer, it stays closed after a page refresh.

### Storage and safety
- Remembered UI preferences are kept separately per Annex browser tab using `chrome.storage.session` and are cleared when the tab closes. They are never sent to the Annex server or Marks Portal API.
- Existing Marks Portal account/token storage is unchanged. No new passwords, student list, roll-number data, or attendance matrix is stored as UI state.
- The extension **never** clicks Annex Submit or invokes its submit action. It only observes the teacher's manual submission and, after a newly detected success message, reloads the page.
- An actual page reload temporarily tears down and recreates a page-injected drawer. This build restores it automatically; a completely uninterrupted browser-native panel would need a separate Chrome Side Panel version.

### Testing note
The fill/restore/next-date workflow and fresh-success-triggered page reload were checked using a local browser mock of the Annex form. Actual Annex production DOM and submission behavior need a live signed-in acceptance check because Annex is a third-party site.
