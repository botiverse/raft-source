import { useIntl } from "react-intl";
import { appAbilities } from "./agentAppGrants";

/**
 * What one grant lets an App do: each ability in plain words ("Sign in as this agent"), with the
 * raw scopes behind it in small mono text under it. A scope without words is shown as itself.
 */
export function AppGrantAbilities({ scopes }: { scopes: readonly string[] }) {
  const { formatMessage } = useIntl();
  return (
    <ul className="m-0 list-none stack-y-1 p-0" data-testid="agent-app-grant-abilities">
      {appAbilities(scopes).map((ability) => (
        <li key={ability.key} className="min-w-0">
          {ability.long ? (
            <>
              <div className="text-subhead text-foreground">{formatMessage({ id: ability.long })}</div>
              <div className="break-all font-mono text-mono-meta text-foreground-hint">{ability.scopes.join(" / ")}</div>
            </>
          ) : (
            <div className="break-all font-mono text-mono-meta text-foreground">{ability.scopes[0]}</div>
          )}
        </li>
      ))}
    </ul>
  );
}
