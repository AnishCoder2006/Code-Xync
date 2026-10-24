# On Accept: compares the document's current state vector to the baseVersion
# recorded when the AI request started. If the touched lines changed, reject
# with "file changed while AI was working" instead of force-applying.
# See design doc section 5.3.
# TODO: implement.
