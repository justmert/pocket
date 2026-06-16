import { mono, moneySizes, radius, type MoneyTreatment, type Theme } from "./theme";

/**
 * An amount, rendered according to what is actually true about it.
 *
 *   plain    a public balance
 *   sealed   confidential: on chain only as a commitment
 *   exposed  is or is becoming public (shield, unshield, fees)
 *
 * The `exposed` colour is reserved. If it starts appearing decoratively it
 * stops carrying information, which is the whole point of it.
 */
export function Money({
  amount,
  code,
  treatment = "plain",
  size = "inline",
  t,
}: {
  amount: string;
  code?: string;
  treatment?: MoneyTreatment;
  /** By what the amount is, not by which screen shows it. */
  size?: keyof typeof moneySizes;
  t: Theme;
}) {
  const styles: Record<MoneyTreatment, React.CSSProperties> = {
    plain: { color: t.text },
    sealed: {
      color: t.sealedText,
      background: t.sealed,
      padding: "2px 8px",
      borderRadius: radius.sm,
    },
    exposed: {
      color: t.exposed,
      background: t.exposedBg,
      padding: "2px 8px",
      borderRadius: radius.sm,
    },
  };
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: moneySizes[size],
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
        ...styles[treatment],
      }}
    >
      {amount}
      {code ? <span style={{ opacity: 0.7, marginLeft: 5 }}>{code}</span> : null}
    </span>
  );
}
