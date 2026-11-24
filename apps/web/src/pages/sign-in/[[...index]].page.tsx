import { SignInView } from "../../lib/auth";
import { AuthLayout } from "../../components/AuthLayout";

export default function Page() {
  return (
    <AuthLayout mode="sign-in">
      <SignInView />
    </AuthLayout>
  );
}
