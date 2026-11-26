
# API and Integration Agreement

## Base URL

Local development:

`http://localhost:3001/api/allocation`

Integrated local proxy (after deployment):

`http://localhost:8080/api/allocation`

## Authentication

The Allocation Service uses Amazon Cognito for user
authentication.

Send JSON requests with:

`Content-Type: application/json`

Except for login and internal permit validation, all API
requests require:

`Authorization: Bearer <Cognito-Access-Token>`

Successful response:

```json
{"success":true,"data":...}
```

Error response:

```json
{"success":false,"error":{"code":"...","message":"..."}}
```

## API Endpoints

| Method and path | Input and result |
|---|---|
| POST /auth/login | Send username and password. Cognito authenticates the user and returns an access token and its expiry duration. |
| POST /requests | Submit the six parking request fields. Returns 201 with the request status and reservation ID if allocated. Supports an optional Idempotency-Key header. |
| GET /requests | Returns the user's own requests or all requests for administrators. Supports status, request_type and priority filters. |
| GET /requests/:id | Retrieve a request belonging to the authenticated user, or any request for administrators. |
| PATCH /requests/:id | Edit the six input fields of a waiting request and re-evaluate eligibility. |
| POST /requests/:id/cancel | Cancel a waiting or allocated request. The associated reservation is closed in the same transaction. |
| POST /requests/:id/assign | Admin only. Send a spot_id to assign a matching available parking spot. |
| GET /reservations/:id | Owner or administrator retrieves reservation details. |
| PATCH /reservations/:id/cancel | Owner or administrator cancels a reservation and its associated request. |
| POST /reservations/:id/renew | Extend a reservation using a later end_time. Returns 409 if the extension conflicts with another booking. |
| GET /waitlist/me | Returns the user's waiting requests and their queue positions. |
| POST /pricing/quote | Returns estimated parking price, duration, hourly rate and surcharge multiplier. |
| POST /admin/maintenance | Admin only. Executes one expiry and waitlist promotion pass. |
| GET /internal/reservations/:id/validity | Incident Service only. Requires a separate internal service token. |

## Testing with Postman

### 1. Login

POST:

`http://localhost:3001/api/allocation/auth/login`

Body:

```json
{
  "username": "student1",
  "password": "YOUR_COGNITO_PASSWORD"
}
```

The username student1 is a fictional demonstration
account representing a registered parking user.

Copy the returned `data.access_token`.

Do not publish real passwords or access tokens.

### 2. Submit a parking request

POST:

`http://localhost:3001/api/allocation/requests`

In Postman, select Bearer Token authentication and
provide the Cognito access token.

Body:

```json
{
  "zone_id": "zone_1",
  "spot_type": "standard",
  "request_type": "daily",
  "vehicle_plate": "ABC123",
  "start_time": "2027-01-15T09:00:00Z",
  "end_time": "2027-01-15T11:00:00Z"
}
```

Adjust the dates to a valid future booking period.

### 3. Retrieve the request and reservation

Copy the returned request_id and reservation_id.

Use the corresponding GET endpoints.

A second registered user can request the same parking
window to demonstrate waitlist functionality in sample
Inventory mode.

## Request and Reservation States

Request states:

- waitlisted
- allocated
- cancelled
- expired

Reservation states:

- confirmed
- cancelled
- expired

A pricing quote is an estimate. The final reservation
price uses availability at confirmation.

## HTTP Status Codes

| Code | Meaning |
|---|---|
| 200 | Successful operation |
| 201 | Request created |
| 400 | Invalid input |
| 401 | Missing or invalid authentication |
| 403 | Insufficient permissions |
| 404 | Missing resource or resource owned by another user |
| 409 | Booking or state conflict |
| 413 | Request body too large |
| 415 | Unsupported content type |
| 429 | Rate limit exceeded |
| 503 | Unavailable dependency or unresolved write contention |

## Inventory Service Integration

The agreed interface must be verified during team
integration.

Configure:

- INVENTORY_MODE=http
- INVENTORY_URL=http://localhost:3002
- INVENTORY_TOKEN supplied securely by Inventory Service

Allocation sends:

```http
GET /api/inventory/spots?zone_id=zone_1&spot_type=standard
Authorization: Bearer <Inventory service token>
```

Expected response:

```json
{
  "data": [
    {
      "spot_id": "A1",
      "zone_id": "zone_1",
      "spot_type": "standard",
      "active": true
    }
  ]
}
```

Spot IDs must be globally unique.

Inventory owns parking zones, parking spots and their
active status.

Allocation owns booking windows, reservations,
waitlists and pricing.

Inventory returns the complete matching catalogue,
including already booked spots.

Allocation determines whether a spot is available for
the requested period.

Inventory reads and Allocation reservation transactions
are not atomic across services. A shared hold/confirm
protocol would be required to eliminate concurrent
spot-deactivation risks.

An empty matching catalogue may result in a waiting
request. An unavailable Inventory Service returns
503 on new submissions.

## Incident Service Integration

The Incident Service calls:

`GET /api/allocation/internal/reservations/:id/validity`

Authentication:

`Authorization: Bearer <INTERNAL_TOKEN>`

Both services must receive the same token securely.

The token must never be exposed to the frontend or
committed to GitHub.

Example valid reservation response:

```json
{
  "success": true,
  "data": {
    "reservation_id": "res_...",
    "valid": true,
    "spot_id": "A1",
    "vehicle_plate": "ABC123"
  }
}
```

A missing, cancelled, future or ended reservation
returns valid:false with null spot and plate values.

The Incident Service compares the returned vehicle
plate with the presented vehicle.

The Incident Service owns QR permit handling and
incident reports.

## Shared Cognito Authentication

All three backend services are intended to use the
same Cognito User Pool and App Client during final
team integration.

Cognito is responsible for:

- Managing user credentials.
- Authenticating users.
- Issuing RS256 access tokens.
- Managing user and admin groups.

Each backend independently verifies the access token
before processing protected requests.

Token verification includes:

- RS256 digital signature.
- Trusted Cognito public signing key.
- Token issuer.
- App Client ID.
- Expiration time.
- Access token type.
- User identity.

The Allocation Service obtains the role from the
verified Cognito groups.

The authenticated user's Cognito sub identifier is
mapped to an application user ID and parking priority.

Parking priority is controlled by the backend, not
by the client.

## Identity Mapping

Local development uses:

`COGNITO_USERS_FILE=.local/cognito-users.json`

The recorded ECS task definition references a
Secrets Manager entry through:

`COGNITO_USERS_JSON`

Both configurations use the same Cognito
authentication mechanism.

The current identity mapping is intended for the
controlled demonstration accounts. A production
system would require persistent user provisioning
and identity management.

## Secrets Management

Required Allocation secrets:

- parking/allocation/validity
- parking/allocation/cognito-users

HTTP Inventory integration additionally requires:

- parking/allocation/inventory

No legacy JWT signing secret or local password
database is required.

Secret values must not be included in GitHub,
frontend code, screenshots or application logs.

## Deployment

The university deployment uses Floci.

AWS infrastructure is provisioned through Bash
scripts in infra/services/.

Following the Lab 8 approach, ECS and ALB resources
are recorded in Floci, while local Node.js workers
and a local proxy provide application execution.

Recorded ECS configuration does not establish
actual Fargate execution or runtime IAM enforcement.
