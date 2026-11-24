import { SignUpView } from "../../lib/auth";
import { AuthLayout } from "../../components/AuthLayout";

export default function Page() {
  return (
    <AuthLayout mode="sign-up">
      <SignUpView />
    </AuthLayout>
  );
}
