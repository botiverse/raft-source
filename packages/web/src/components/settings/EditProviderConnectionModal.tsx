import { Button, Checkbox, Input, Spinner } from "@botiverse/raft-ui";
import { Pencil } from "lucide-react";
import { useCallback, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useIntl } from "react-intl";
import type {
  ProviderConnectionProviderOption,
  ProviderConnectionSummary,
} from "@botiverse/raft-shared";
import api from "../../api/client";
import Banner from "../ui/Banner";
import DialogCard from "../ui/DialogCard";
import FormField from "../ui/FormField";
import { DialogCardFooter, DialogCommit } from "../ui/NarrowDialog";

export default function EditProviderConnectionModal({
  connection,
  providerOptions,
  onClose,
  onCompleted,
  layer,
}: {
  connection: ProviderConnectionSummary;
  providerOptions: ProviderConnectionProviderOption[];
  onClose: () => void;
  onCompleted: () => Promise<void>;
  /** The layer of the dialog it is rendered inside (the runtime editor's 1), so it stacks over that one. */
  layer?: 0 | 1;
}) {
  const { formatMessage } = useIntl();
  // oxlint-disable-next-line react-doctor/no-derived-useState -- the keyed modal snapshots the selected row when it opens; catalog refreshes must not overwrite in-progress input.
  const [name, setName] = useState(connection.name);
  const [apiKey, setApiKey] = useState("");
  // oxlint-disable-next-line react-doctor/no-derived-useState -- same keyed modal snapshot contract as the name field above.
  const [endpointUrl, setEndpointUrl] = useState(connection.endpointUrl ?? "");
  // oxlint-disable-next-line react-doctor/no-derived-useState -- same keyed modal snapshot contract as the name field above.
  const [supportsImageInput, setSupportsImageInput] = useState(connection.supportsImageInput);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const handleNameChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setName(event.target.value), []);
  const handleEndpointUrlChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setEndpointUrl(event.target.value),
    [],
  );
  const handleApiKeyChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setApiKey(event.target.value), []);
  const handleSupportsImageInputChange = useCallback(
    (checked: boolean) => setSupportsImageInput(checked === true),
    [],
  );
  const gateway = providerOptions.find((entry) => entry.id === connection.providerId)?.providerKind === "gateway";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const payload: {
        name: string;
        endpointUrl?: string;
        supportsImageInput?: boolean;
        apiKey?: string;
      } = {
        name: name.trim(),
        ...(gateway ? { endpointUrl: endpointUrl.trim(), supportsImageInput } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      };
      await api.patch(`/provider-connections/${connection.id}`, payload);
      await onCompleted();
    } catch {
      setError(formatMessage({ id: "settings.providers.actionError" }));
    } finally {
      setSubmitting(false);
    }
  };

  const nameInputId = `provider-connection-${connection.id}-edit-name`;
  const endpointInputId = `provider-connection-${connection.id}-edit-endpoint`;
  const apiKeyInputId = `provider-connection-${connection.id}-edit-key`;
  const imageInputId = `provider-connection-${connection.id}-edit-image`;

  return (
    <DialogCard
      onClose={onClose}
      title={formatMessage({ id: "settings.providers.editTitle" }, { name: connection.name })}
      testId="provider-connection-edit-dialog"
      narrow="sheet"
      // Rendered inside the dialog it opens from (Create Agent, the agent detail runtime editor), so raft-ui stacks it
      // over that one; it takes that dialog's layer (the editor is at 1). From Settings it is the only dialog.
      layer={layer}
    >
      <form onSubmit={submit} className="stack-y-4 md:pointer-fine:stack-y-3" data-testid="provider-connection-edit-form">
        <FormField label={formatMessage({ id: "settings.providers.name" })} htmlFor={nameInputId}>
          <Input
            id={nameInputId}
            className="w-full"
            value={name}
            onChange={handleNameChange}
            maxLength={120}
            required
            autoFocus
          />
        </FormField>
        {gateway && (
          <FormField label={formatMessage({ id: "settings.providers.endpoint" })} htmlFor={endpointInputId}>
            <Input
              id={endpointInputId}
              className="w-full"
              type="url"
              value={endpointUrl}
              onChange={handleEndpointUrlChange}
              required
            />
          </FormField>
        )}
        <FormField
          label={formatMessage({ id: "settings.providers.apiKey" })}
          htmlFor={apiKeyInputId}
          hint={formatMessage({ id: "settings.providers.editApiKeyHint" })}
        >
          <Input
            id={apiKeyInputId}
            className="w-full"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={handleApiKeyChange}
          />
        </FormField>
        {gateway && (
          <label htmlFor={imageInputId} className="flex items-center gap-2 text-callout font-semibold text-foreground">
            <Checkbox
              id={imageInputId}
              checked={supportsImageInput}
              onCheckedChange={handleSupportsImageInputChange}
            />
            {formatMessage({ id: "settings.providers.imageInput" })}
          </label>
        )}
        {error && <Banner intent="warning" density="sm">{error}</Banner>}
        <DialogCardFooter>
          <Button size="lg" type="button" variant="ghost" onClick={onClose}>
            {formatMessage({ id: "settings.common.cancel" })}
          </Button>
          <DialogCommit>
            {(inHead) => (
              <Button size={inHead ? "md" : "lg"}
                type="submit"
                variant="primary"
                disabled={submitting || !name.trim() || (gateway && !endpointUrl.trim())}
              >
                {submitting ? <Spinner size="sm" aria-hidden="true" /> : <Pencil size={16} />}
                {formatMessage({ id: "settings.providers.saveChanges" })}
              </Button>
            )}
          </DialogCommit>
        </DialogCardFooter>
      </form>
    </DialogCard>
  );
}
