import { validateEmailAddress } from "./validator";

if (!validateEmailAddress("alice+codesync@example.com")) {
    throw new Error("Valid plus-addressed email was rejected!");
}
