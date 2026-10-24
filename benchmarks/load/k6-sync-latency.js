// k6 script: simulate N concurrent WebSocket clients editing the same room,
// measure p95 edit-to-peer latency. See design doc section 7.1.
// TODO: implement using k6's ws module.
