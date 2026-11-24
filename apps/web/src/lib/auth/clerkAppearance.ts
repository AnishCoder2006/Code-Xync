/**
 * Clerk appearance for <SignIn /> and <SignUp /> (one place for both pages).
 * The form sits inside AuthLayout's card, so Clerk's own card is transparent and its header
 * is hidden (AuthLayout shows our heading). Colours are literals because Clerk derives
 * shades from them; they mirror globals.css.
 *
 * The primary button uses the theme's deeper orange (#c2410c) in both themes: white on it is
 * 5.2:1, while white on the brighter dark-theme orange (#f05a26) is only 3.4:1.
 * The `!` classes are needed because Clerk's runtime styles are inserted after ours.
 */
const VARIABLES = {
  dark: {
    colorPrimary: "#c2410c",
    colorTextOnPrimaryBackground: "#ffffff",
    colorText: "#f3efe8",
    colorTextSecondary: "#cfc9bf",
    colorBackground: "#232120",
    colorInputBackground: "#1c1a17",
    colorInputText: "#f3efe8",
    colorNeutral: "#f3efe8",
    colorDanger: "#f2716b",
  },
  light: {
    colorPrimary: "#c2410c",
    colorTextOnPrimaryBackground: "#ffffff",
    colorText: "#161513",
    colorTextSecondary: "#4a463f",
    colorBackground: "#fbfaf6",
    colorInputBackground: "#ffffff",
    colorInputText: "#161513",
    colorNeutral: "#161513",
    colorDanger: "#b42318",
  },
} as const;

export function clerkAuthAppearance(scheme: "light" | "dark") {
  const dark = scheme === "dark";
  return {
    layout: {
      socialButtonsPlacement: "top" as const,
      socialButtonsVariant: "blockButton" as const,
      logoPlacement: "none" as const,
    },
    variables: {
      ...VARIABLES[scheme],
      borderRadius: "10px",
      fontFamily: "var(--font-sans), ui-sans-serif, system-ui, sans-serif",
      fontSize: "0.9375rem",
    },
    elements: {
      rootBox: "!w-full",
      cardBox: "!w-full !max-w-none !border-0 !bg-transparent !shadow-none !rounded-none",
      card: "!border-0 !bg-transparent !shadow-none !px-0 !pt-0 !pb-2 !gap-6",
      header: "!hidden",
      headerTitle: "!hidden",
      headerSubtitle: "!hidden",
      // Google and GitHub side by side; one column only if the card gets very narrow.
      socialButtons: "!grid !grid-cols-1 min-[340px]:!grid-cols-2 !gap-2.5",
      socialButtonsBlockButton: dark
        ? "!h-11 !border !border-solid !border-[#4a453f] !bg-[#1c1a17] !text-white !shadow-none hover:!border-[#6b655c] hover:!bg-[#2a2725]"
        : "!h-11 !border !border-solid !border-[#d4cec2] !bg-white !text-[#161513] !shadow-none hover:!border-[#a8a194] hover:!bg-[#f4f1ea]",
      socialButtonsBlockButtonText: "!font-medium !text-[14px]",
      // GitHub's mark is black; on the dark card it would vanish.
      socialButtonsProviderIcon__github: dark ? "!invert" : "",
      dividerLine: dark ? "!bg-[#3a3631]" : "!bg-[#ddd7cc]",
      dividerText: "!text-[13px]",
      formFieldLabel: "!font-medium",
      formFieldInput: dark
        ? "!h-11 !border !border-solid !border-[#4a453f] !shadow-none focus:!border-[#f05a26]"
        : "!h-11 !border !border-solid !border-[#cfc8bb] !shadow-none focus:!border-[#c2410c]",
      formButtonPrimary:
        "!h-11 !bg-[#c2410c] !text-white !font-semibold !normal-case !text-[15px] !shadow-none hover:!bg-[#a8380a]",
      footer: "!bg-none !bg-transparent",
      footerAction: "!justify-center",
      footerActionText: "!text-[14px]",
      footerActionLink: dark ? "!font-semibold !text-[#f05a26] hover:!text-[#ff7a4a]" : "!font-semibold !text-[#c2410c] hover:!text-[#a8380a]",
      identityPreviewEditButton: dark ? "!text-[#f05a26]" : "!text-[#c2410c]",
      formResendCodeLink: dark ? "!text-[#f05a26]" : "!text-[#c2410c]",
    },
  };
}

/** Provider-wide variables (user menu popover etc.), same colours as the forms. */
export function clerkProviderVariables(scheme: "light" | "dark") {
  return { ...VARIABLES[scheme], borderRadius: "10px", fontFamily: "var(--font-sans), ui-sans-serif, system-ui, sans-serif" };
}
