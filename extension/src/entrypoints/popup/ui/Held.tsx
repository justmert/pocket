// value that is yours and is not spendable yet.
//
// this state is ordinary to the system and alarming to a person, and it happens
// in three unrelated places: funds received into the private pocket and not yet
// merged, a confidential entry gone dormant, and a device record that has to be
// rebuilt before it can be read. presented three different ways, a user meeting
// any of them for the first time cannot tell "this is fine, one press fixes it"
// from "your money is gone".
//
// so it is one shape, and the second time someone meets it they already know how
// it ends: what the figure is, one line saying what is holding it, and one
// control saying what releases it.
//
// the figure is the part that has to be handled honestly. `spendable` and
// `receiving` are optional on the wire, and in a dormant or unrebuilt pocket the
// wallet genuinely cannot read them. so an absent figure is SAID rather than
// drawn as a zero, which is the same rule the hero already follows: "not known"
// and "none" are different facts and only one of them is about the user.
import type { ReactNode } from "react";
import { Amount } from "./Amount";
import { Button, ButtonStack, Card } from "./primitives";
import { space, text, type Theme } from "./theme";

export function Held({
  t,
  /** what this held value is called, in the user's words. */
  label,
  /** the figure, when the wallet has actually read it. */
  amount,
  code,
  /** one sentence: what is holding it. */
  holding,
  /** the control that releases it, where one exists. */
  action,
  /** the other way out, where one exists. */
  secondary,
  /** anything that has to sit above the figure, such as the worker's own message. */
  children,
}: {
  t: Theme;
  label: string;
  amount?: string;
  code?: string;
  holding: ReactNode;
  /**
   * optional, because some states genuinely have no way out from here.
   *
   * offering a control that cannot succeed is worse than offering none: the
   * dormant pocket used to carry a rebuild button that answered "this account
   * has no private pocket yet" to someone looking at their own balance.
   */
  action?: { label: string; onClick: () => void; busy?: boolean };
  secondary?: { label: string; onClick: () => void; busy?: boolean };
  children?: ReactNode;
}) {
  return (
    <Card t={t} tone="accent">
      {children}
      <span style={{ ...text.rowSub, color: t.sub, display: "block" }}>{label}</span>
      {amount !== undefined ? (
        // the same numeric style as a spendable balance: never dimmed, never
        // approximated. it is the user's money and it is not less real for
        // being stuck.
        <Amount t={t} value={amount} code={code} size="row" />
      ) : (
        <span style={{ ...text.rowTitle, color: t.sub, display: "block" }}>
          Not readable on this device yet
        </span>
      )}
      <div style={{ ...text.caption, color: t.sub, marginTop: space.xs, lineHeight: 1.45 }}>
        {holding}
      </div>
      {(action || secondary) && (
        <ButtonStack>
          {action && (
            <Button t={t} busy={action.busy} onClick={action.onClick}>
              {action.label}
            </Button>
          )}
          {secondary && (
            <Button t={t} variant="quiet" busy={secondary.busy} onClick={secondary.onClick}>
              {secondary.label}
            </Button>
          )}
        </ButtonStack>
      )}
    </Card>
  );
}
