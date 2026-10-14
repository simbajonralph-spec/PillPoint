# Local Demo Credentials

These fictional accounts are for an isolated local/demo database only. Demo seeding is refused when `NODE_ENV=production`. Passwords are stored as bcrypt hashes.

The local demo administrator account is `demo.admin@pillpoint.test` with password `PillPointDemo!2026`. A demo customer account is `customer@pillpoint.test` with that same password.

All seven verified pharmacy staff accounts use password `PillPointDemo!2026`:

| Branch | Email | Password |
|---|---|---|
| Demo Harborview Pharmacy | `demo.pharmacy01@pillpoint.test` | `PillPointDemo!2026` |
| Demo Sampaguita Drugstore | `demo.pharmacy02@pillpoint.test` | `PillPointDemo!2026` |
| Demo Sunrise Community Pharmacy | `demo.pharmacy03@pillpoint.test` | `PillPointDemo!2026` |
| Demo Maharlika Health Pharmacy | `demo.pharmacy04@pillpoint.test` | `PillPointDemo!2026` |
| Demo Balangay Pharmacy | `demo.pharmacy05@pillpoint.test` | `PillPointDemo!2026` |
| Demo Amihan Wellness Drugstore | `demo.pharmacy06@pillpoint.test` | `PillPointDemo!2026` |
| Demo Bayani Care Pharmacy | `demo.pharmacy07@pillpoint.test` | `PillPointDemo!2026` |

Run `npm run seed:demo` with `PILLPOINT_DEMO_SEED=true` set in the environment. In PowerShell:

```powershell
$env:PILLPOINT_DEMO_SEED = 'true'
npm run seed:demo
Remove-Item Env:PILLPOINT_DEMO_SEED
npm start
```

Seeding is repeatable and preserves unrelated records. It adds three pending registration records; their demo staff can log in but those branches have no inventory and are not customer-facing until an administrator approves them.
