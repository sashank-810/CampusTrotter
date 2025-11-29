# Shuttle Tracking Service

## Issue
Provide real-time shuttle location, route schedules, and next arrival times.

## Input Interfaces
- **GET /shuttles**
- **GET /shuttle/{id}/location**
- **GET /routes/{routeId}/schedule**

## Output Interfaces
- **200 OK** with shuttle list and locations
- **200 OK** with route schedule and next arrival times
- **404 Not Found** for invalid shuttle/route

## Data Validation
- Validate shuttle/route IDs
- Handle missing or stale GPS data
- Return consistent timestamps in ISO format

## Acceptance Criteria
- Real-time location updates within ≤10s
- Route schedules display correct 20-min frequency
- Invalid IDs return 404
