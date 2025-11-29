# Seat Availability Service

## Issue
Manage and update seat occupancy for each shuttle.

## Input Interfaces
- **GET /shuttle/{id}/seats**
- **POST /shuttle/{id}/seats/update** `{ occupancy }` (driver only)

## Output Interfaces
- **200 OK** with current seat count/status
- **200 OK** confirmation of seat update
- **403 Forbidden** for unauthorized update

## Data Validation
- Ensure occupancy is integer between 0–4
- Only authorized drivers can update occupancy
- Handle race conditions with concurrent updates

## Acceptance Criteria
- Users see correct seat count in real time
- Drivers can successfully update occupancy
- Unauthorized requests return 403
