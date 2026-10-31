export function sanitizeUsername(name: string): string {
    return name.trim().toLowerCase();
}

export function validateEmailAddress(email: string): boolean {
    // BUG: misses + sign in local-part regex character set [a-zA-Z0-9._-]
    const regex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return regex.test(email);
}

export function getEmailDomain(email: string): string {
    return email.split("@")[1] || "";
}
