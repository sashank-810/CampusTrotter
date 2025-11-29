# Notification Service

## Issue
Send real-time alerts and notifications to users and drivers.

## Input Interfaces
- **POST /notify** `{ message, target: [users|drivers|admins] }` (admin only)

## Output Interfaces
- **200 OK** confirmation of notification sent
- **400 Bad Request** for invalid payload

## Data Validation
- Ensure message is non-empty
- Validate target audience
- Authenticate only admins to send notifications

## Acceptance Criteria
- Admins can send push notifications to selected roles
- Invalid payloads return 400
- All intended recipients receive notification within ≤5s
