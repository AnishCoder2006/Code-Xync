# Attack payload: infinite stdout flood. Must be contained by the output byte cap.
while True:
    print("x" * 1000)
