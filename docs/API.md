
# API and Integration Agreement

## Base URL

Local development:

`http://localhost:3001/api/allocation`

Integrated local proxy:

`http://localhost:8080/api/allocation`

## Authentication

The Allocation Service uses Amazon Cognito for user
authentication.

Send JSON requests with:

`Content-Type: application/json`

Except for login and internal reservation verification
endpoints, all API requests require:

`Authorization: Bearer <Cognito-Access-Token>`

Internal reservation verification endpoints require:

`Authorization: Bearer <INTERNAL_TOKEN>`

Successful response:

```json
{"success":true,"data":{}}
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
| PATCH /requests/:id | Edit the input fields of a waiting request and re-evaluate eligibility. |
| POST /requests/:id/cancel | Cancel a waiting or allocated request. The associated reservation is closed in the same transaction. |
| POST /requests/:id/assign | Admin only. Send a spot_id to assign a matching available parking spot. |
| GET /reservations/:id | Owner or administrator retrieves reservation details. |
| PATCH /reservations/:id/cancel | Owner or administrator cancels a reservation and its associated request. |
| POST /reservations/:id/renew | Extend a reservation using a later end_time. Returns 409 if the extension conflicts with another booking. |
| GET /waitlist/me | Returns the user's waiting requests and their queue positions. |
| POST /pricing/quote | Returns estimated parking price, duration, hourly rate and surcharge multiplier. |
| POST /admin/maintenance | Admin only. Executes one expiry and waitlist promotion pass. |
| GET /internal/reservations/:id/validity | Incident Service only. Verifies a reservation using its ID. Requires an internal service token. |
| GET /internal/reservations/lookup | Incident Service only. Checks for a currently valid reservation using vehicle_plate and spot_id. Requires an internal service token. |

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

### 4. Verify a reservation by ID

GET:

`http://localhost:3001/api/allocation/internal/reservations/res_123/validity`

Replace res_123 with an existing reservation ID.

In Postman, select Bearer Token authentication and
provide the internal service token instead of a
Cognito access token.

The reservation must be confirmed and within its
active booking period to return valid:true.

### 5. Lookup a reservation by vehicle plate and spot

GET:

`http://localhost:3001/api/allocation/internal/reservations/lookup?vehicle_plate=ABC123&spot_id=A1`

In Postman, select Bearer Token authentication and
provide the internal service token.

Use the actual vehicle plate and parking spot ID
of an existing reservation.

The reservation must be confirmed and currently
active to return valid:true.

A future reservation returns valid:false even when
the vehicle plate and spot ID match.

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
| 500 | Unexpected application or database error |
| 503 | Unavailable dependency, unresolved write contention or conflicting active reservation records |

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

The reservation lookup currently accepts spot IDs
containing letters, numbers, underscores and hyphens,
with a maximum length of 64 characters.

The spot ID format must be consistent between
Allocation, Inventory and Incident Services.

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

The Allocation Service provides two internal APIs for
the Incident Reports Service.

### Internal Authentication

Both endpoints require:

`Authorization: Bearer <INTERNAL_TOKEN>`

Both services must receive the same token securely.

The token must never be exposed to the frontend,
included in screenshots or committed to GitHub.

Cognito user and admin access tokens cannot replace
the internal service token.

### 1. Reservation Validity Verification

Endpoint:

`GET /api/allocation/internal/reservations/:id/validity`

Purpose:

Allows the Incident Service to verify a reservation
using its reservation ID.

This endpoint supports QR permit verification.

The planned shared frontend will use the reservation
ID as the QR permit reference. Frontend QR generation
has not yet been completed.

Example valid reservation response:

```json
{
  "success": true,
  "data": {
    "reservation_id": "res_123",
    "valid": true,
    "spot_id": "A1",
    "vehicle_plate": "ABC123"
  }
}
```

A missing, cancelled, future or ended reservation
returns valid:false with null spot and plate values.

Example invalid reservation response:

```json
{
  "success": true,
  "data": {
    "reservation_id": "res_123",
    "valid": false,
    "spot_id": null,
    "vehicle_plate": null
  }
}
```

The Incident Service compares the returned vehicle
plate and parking spot with the presented vehicle
and permit information.

A reservation ID or QR code alone is not sufficient
to prove that the presented vehicle matches the
reservation.

### 2. Reservation Lookup by Vehicle Plate and Spot

Endpoint:

`GET /api/allocation/internal/reservations/lookup`

Required query parameters:

- vehicle_plate
- spot_id

Example request:

```http
GET /api/allocation/internal/reservations/lookup?vehicle_plate=ABC123&spot_id=A1
Authorization: Bearer <INTERNAL_TOKEN>
```

Purpose:

Allows the Incident Service to investigate possible
unauthorized parking when the reservation ID is
unknown.

For example, a user may report a vehicle occupying
parking spot A1 but may not know the reservation ID
associated with that vehicle.

The Allocation Service checks whether a reservation:

- Matches the supplied vehicle plate.
- Matches the supplied parking spot.
- Has a confirmed status.
- Has already started.
- Has not reached its end time.

Vehicle plates are validated and normalized using
the same rules as parking request creation.

Leading and trailing spaces are removed, and English
letters are converted to uppercase.

Arabic and English vehicle plates are supported.

Internal spaces and hyphens are preserved.

Query parameter values must be URL-encoded where
necessary.

Example matching reservation response:

```json
{
  "success": true,
  "data": {
    "valid": true,
    "reservation_id": "res_123",
    "spot_id": "A1",
    "vehicle_plate": "ABC123"
  }
}
```

Example response when no active reservation matches:

```json
{
  "success": true,
  "data": {
    "valid": false,
    "reservation_id": null,
    "spot_id": null,
    "vehicle_plate": null
  }
}
```

Possible HTTP status codes:

| Code | Meaning |
|---|---|
| 200 | Lookup completed, whether a match exists or not |
| 400 | Missing, invalid, duplicate or unexpected query parameters |
| 401 | Missing or invalid internal service token |
| 429 | Rate limit exceeded |
| 500 | Unexpected application or database error |
| 503 | Multiple matching active reservation records |

A valid:false response indicates that no matching
active reservation was found.

It does not automatically prove that a vehicle is
illegally parked. The Incident Service should use
this result to support further investigation.

The Incident Service must not interpret an API error,
timeout or unavailable Allocation Service as an
unauthorized parking violation.

The lookup checks reservation validity at the time
of the API request. It does not verify historical
parking authorization at an earlier incident time.

### Service Responsibilities

The Allocation Service owns:

- Parking reservations.
- Reservation validity rules.
- Reservation lookup.
- Booking periods and reservation states.
- Automatic allocation.
- Priority-based waiting lists.
- Dynamic pricing.

The Incident Service owns:

- QR permit handling.
- Incident submission.
- Possible violation detection.
- Incident investigation and resolution.

Permit verification and incident submission remain
separate functions.

The Incident Service must use the internal APIs
instead of directly accessing Allocation's DynamoDB
tables.

### Implementation and Testing Status

Both internal reservation verification APIs have
been implemented and individually tested.

The Allocation Service passed:

- 6 out of 6 unit tests.
- 15 out of 15 API integration tests.

Four new API tests cover reservation lookup
functionality, input validation, internal
authentication and conflicting reservation records.

The API tests use isolated temporary DynamoDB
tables through Floci.

Tested lookup scenarios include:

- Matching active reservations.
- Vehicle plate normalization.
- Arabic vehicle plates.
- Incorrect vehicle plates.
- Incorrect parking spots.
- Future reservations.
- Expired reservations.
- Cancelled reservations.
- Missing internal tokens.
- Incorrect internal tokens.
- Cognito user and admin token rejection.
- Missing and invalid query parameters.
- Duplicate and unexpected query parameters.
- Multiple matching active reservations.

Live integration with the actual Incident Reports
Service remains pending.

### Current Limitations

The reservation lookup uses a DynamoDB table scan,
which is suitable for the controlled coursework
dataset.

A larger production system would benefit from a
suitable secondary index to improve lookup
performance.

The lookup does not independently verify the
physical presence or location of a vehicle.

The lookup result is based on reservation records
at the time of verification.

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

Shared Cognito authentication must be verified
during final team integration.

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

The internal reservation validity and lookup
endpoints use the same INTERNAL_TOKEN.

No legacy JWT signing secret or local password
database is required.

Secret values must not be included in GitHub,
frontend code, screenshots or application logs.

## Shared Frontend

The project will use one shared frontend developed
using HTML, CSS and JavaScript.

Frontend development will begin after the individual
backend services are completed and tested.

The shared frontend will provide:

- Consistent visual design.
- Shared authentication.
- Shared navigation.
- Parking inventory pages.
- Parking request and reservation pages.
- Waiting list and pricing information.
- Incident submission and investigation pages.
- QR permit functionality.
- Cloudflare Turnstile on the incident submission form.

The frontend will communicate with the backend
services through the shared routing proxy.

Internal service tokens must never be accessible
to frontend JavaScript.

Internal reservation verification requests must
be performed by the Incident Service backend.

## Deployment

The university deployment uses Floci.

AWS infrastructure is provisioned through Bash
scripts in infra/services/.

Following the Lab 8 approach, ECS and ALB resources
are recorded in Floci, while local Node.js workers
and a local proxy provide application execution.

Recorded ECS configuration does not establish
actual Fargate execution or runtime IAM enforcement.

Local horizontal scaling and request distribution
are provided through multiple Node.js workers and
the local routing proxy.

Final team deployment and end-to-end testing will
be performed after completing individual service
development and testing.
