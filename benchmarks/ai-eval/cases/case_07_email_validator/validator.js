function sanitizeUsername(name) {
    return name.trim().toLowerCase();
}

function validateEmailAddress(email) {
    // BUG: misses + sign in local-part regex character set [a-zA-Z0-9._-]
    const regex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return regex.test(email);
}

function getEmailDomain(email) {
    return email.split("@")[1] || "";
}

module.exports = { sanitizeUsername, validateEmailAddress, getEmailDomain };
