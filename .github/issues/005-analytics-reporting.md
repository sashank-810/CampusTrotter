# Analytics & Reporting Service

## Issue
Generate usage reports, occupancy stats, and system performance metrics.

## Input Interfaces
- **GET /reports/usage?dateRange=...**
- **GET /reports/occupancy?routeId=...**

## Output Interfaces
- **200 OK** with report data (JSON/CSV)
- **404 Not Found** for invalid parameters

## Data Validation
- Validate date range format
- Ensure route IDs exist
- Restrict access to authorized admins

## Acceptance Criteria
- Reports return correct data within 2s
- Invalid inputs return 404
- Data export works in JSON and CSV
