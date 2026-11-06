# Changelog

## 1.3.1 (2026-11-06)
- Microsoft To Do: fixed repeating tasks getting a duplicate and jumping to the next date after an edit. Due dates are now sent as UTC dates, changed tasks are replaced instead of edited, and copies To Do creates on its own are removed.

## 1.3.0 (2026-11-06)
- Renamed from Taskline to **Recurra** (plugin id `recurra`). Settings, the device ID and existing links carry over.
- Follows the Obsidian plugin guidelines: CSS variables instead of inline styles, sentence-case UI text.

## 1.2.0 (2026-11-06)
- Every Google Calendar event and To Do task links back to Obsidian. Each day of a recurring event links to that day's own page, and the links open the Obsidian app on Android too.

## 1.1.0 (2026-11-06)
- A page for each occurrence of a recurring task: an occurrence list in the task note, and one note per day in a folder named after the task.

## 1.0.0 (2026-11-06)
- First release, as Taskline: goal timeline; Today, Week and Upcoming views; recurring tasks with done, skipped and moved occurrences; reminders; one-way sync to Google Calendar and Microsoft To Do.
