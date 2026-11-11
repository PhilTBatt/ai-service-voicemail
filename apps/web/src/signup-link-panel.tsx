// Making a signup link for a new business, on the business list (BUILD_PLAN Step 11): Phil
// and Ant can make one; only Phil can mark it as a test business. The code is shown once.
import type { CreatedSignupLinkView, MeView } from "@callmate/shared";
import { useState } from "react";
import { asError, useApi } from "./api.ts";
import { Alert, Button, Card, Checkbox, ErrorNote } from "./design/components.tsx";
import { Copy, Link2 } from "./design/icons.ts";
import { useToast } from "./design/toast.tsx";
import { formatUkDateTime } from "./time.ts";

export function SignupLinkPanel({ me }: { me: MeView }) {
  const { api } = useApi();
  const toast = useToast();
  const [forTest, setForTest] = useState(false);
  const [made, setMade] = useState<CreatedSignupLinkView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  if (me.role !== "admin" && me.role !== "reseller") return null;
  const url = made ? `${window.location.origin}/signup?code=${made.code}` : "";

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      setMade(
        await api<CreatedSignupLinkView>("/signup-links", { method: "POST", body: { forTest } }),
      );
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      icon={Link2}
      title="Sign up a new business"
      description="Make a link and send it to the tradesperson. It works once, for 14 days."
      footer={
        <>
          <Button variant="secondary" loading={busy} onClick={() => void make()}>
            Create a signup link
          </Button>
          {me.role === "admin" && (
            <Checkbox
              label="Test business"
              description="Can go live while the legal documents are placeholders."
              checked={forTest}
              onChange={(event) => setForTest(event.target.checked)}
            />
          )}
        </>
      }
    >
      {made && (
        <Alert
          tone="success"
          title={`Signup link${made.forTest ? " (test business)" : ""}`}
          actions={
            <Button
              variant="secondary"
              size="sm"
              icon={Copy}
              onClick={() => {
                void navigator.clipboard.writeText(url).then(() => toast({ title: "Link copied" }));
              }}
            >
              Copy link
            </Button>
          }
        >
          <code className="signup-url">{url}</code>
          <p className="muted">
            Works until {formatUkDateTime(made.expiresAt)}. This is the only time it's shown: only a
            fingerprint of it is stored.
          </p>
        </Alert>
      )}
      {error && <ErrorNote error={error} />}
    </Card>
  );
}
