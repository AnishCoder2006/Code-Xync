# Attack payload: attempted host file read. Must fail under the read-only / scoped FS.
print(open("/etc/passwd").read())
