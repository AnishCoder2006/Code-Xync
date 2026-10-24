# Worker service
Consumes execution jobs from BullMQ, runs untrusted code in locked-down Docker containers.
Requires Docker socket access — run on a separate host/VM from the API in production (design doc 3.3).
