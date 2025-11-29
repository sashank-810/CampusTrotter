# User Management Service

## Issue
Implement user registration, authentication (OAuth2/SSO/JWT), and profile management.

## Input Interfaces
- **POST /register** `{ name, email, password/SSO }`
- **POST /login** `{ email, password/SSO }`
- **GET /profile/{userId}`

## Output Interfaces
- **200 OK** with JWT token or SSO session
- **200 OK** with user profile data
- **401 Unauthorized** for invalid credentials

## Data Validation
- Validate email format, password strength
- Enforce mandatory fields
- Check for duplicate accounts
- Use AuthGateway for JWT/SSO handling

## Acceptance Criteria
- Users can register/login with institutional or OAuth2 credentials
- Profile retrieval returns correct data
- Unauthorized attempts return 401
