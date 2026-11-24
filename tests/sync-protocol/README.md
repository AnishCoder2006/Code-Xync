# Playwright multi-client tests
Automated proof of the project's core safety claim: concurrent edits always converge.
Run in CI on every push to services/sync. See design doc section 2.5.
Run locally: `npm install && npx playwright install && npm test`
