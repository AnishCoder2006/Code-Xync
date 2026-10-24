# Attack payload: attempted network egress. Must fail under --network none.
import urllib.request
urllib.request.urlopen("https://example.com")
