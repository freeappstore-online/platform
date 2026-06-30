import { useState, useEffect, useCallback } from "react";
import {
  PROVIDERS,
  fetchVaultStatus,
  saveKeyToVault,
  deleteKeyFromVault,
  getSavedKeys,
  deleteAllLocalKeys,
  hasLocalKeys,
  toVaultProvider,
  type ProviderConfig,
  type VaultKeyStatus,
} from "../lib/ai-keys";

export function AISettings() {
  const [vaultKeys, setVaultKeys] = useState<VaultKeyStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [showLocalMigration] = useState(() => hasLocalKeys());

  const refresh = useCallback(async () => {
    setLoading(true);
    const keys = await fetchVaultStatus();
    setVaultKeys(keys);
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleSave(provider: string) {
    const val = inputValue.trim();
    if (!val) return;
    setSaving(true);
    setError(null);
    const result = await saveKeyToVault(provider, val);
    if (result.ok) {
      setEditing(null);
      setInputValue("");
      await refresh();
    } else {
      setError(result.error || "Failed to save key");
    }
    setSaving(false);
  }

  async function handleRemove(provider: string) {
    setSaving(true);
    await deleteKeyFromVault(provider);
    await refresh();
    setSaving(false);
  }

  async function handleMigrateLocal() {
    setMigrating(true);
    const local = getSavedKeys();
    let migrated = 0;
    for (const [provider, value] of Object.entries(local)) {
      if (value) {
        const res = await saveKeyToVault(provider, value);
        if (res.ok) migrated++;
      }
    }
    if (migrated > 0) {
      deleteAllLocalKeys();
      await refresh();
    }
    setMigrating(false);
  }

  const vaultMap = new Map(vaultKeys.map((k) => [k.provider, k]));

  return (
    <div className="flex flex-col gap-3">
      {/* Migration banner */}
      {showLocalMigration && hasLocalKeys() && (
        <div className="p-3 rounded-xl border" style={{ background: "color-mix(in srgb, var(--warning) 8%, var(--panel))", borderColor: "var(--warning)" }}>
          <p className="text-sm font-semibold" style={{ color: "var(--warning)" }}>Keys stored locally on this device</p>
          <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
            Move them to the platform vault for encrypted storage that works across all devices.
          </p>
          <button
            onClick={handleMigrateLocal}
            disabled={migrating}
            className="mt-2 px-4 py-1.5 rounded-lg text-xs font-semibold text-white"
            style={{ background: "var(--accent)", border: "none", cursor: "pointer", opacity: migrating ? 0.6 : 1 }}
          >
            {migrating ? "Migrating..." : "Migrate to vault"}
          </button>
        </div>
      )}

      {/* Info */}
      <div className="p-3 rounded-xl" style={{ background: "color-mix(in srgb, var(--accent) 5%, var(--panel))" }}>
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          Keys are encrypted (AES-256-GCM) on the platform. Apps never see them — they're resolved server-side when the agent makes API calls.
        </p>
      </div>

      {loading ? (
        <p className="text-sm py-4 text-center" style={{ color: "var(--muted)" }}>Loading keys...</p>
      ) : (
        PROVIDERS.map((p) => (
          <ProviderRow
            key={p.type}
            provider={p}
            vaultStatus={vaultMap.get(toVaultProvider(p.type)) || null}
            isEditing={editing === p.type}
            inputValue={inputValue}
            saving={saving}
            error={editing === p.type ? error : null}
            onStartEdit={() => { setEditing(p.type); setInputValue(""); setError(null); }}
            onInputChange={setInputValue}
            onSave={() => handleSave(p.type)}
            onRemove={() => handleRemove(p.type)}
            onCancel={() => { setEditing(null); setError(null); }}
          />
        ))
      )}
    </div>
  );
}

function ProviderRow({
  provider: p, vaultStatus, isEditing, inputValue, saving, error,
  onStartEdit, onInputChange, onSave, onRemove, onCancel,
}: {
  provider: ProviderConfig;
  vaultStatus: VaultKeyStatus | null;
  isEditing: boolean;
  inputValue: string;
  saving: boolean;
  error: string | null;
  onStartEdit: () => void;
  onInputChange: (v: string) => void;
  onSave: () => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const hasKey = !!vaultStatus;

  return (
    <div className="p-4 rounded-xl border" style={{ background: "var(--panel)", borderColor: "var(--line)" }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <strong className="text-sm">{p.name}</strong>
            {p.free && (
              <span className="text-xs px-1.5 py-0.5 rounded-full font-semibold" style={{ background: "color-mix(in srgb, var(--success) 15%, var(--panel))", color: "var(--success)" }}>
                Free
              </span>
            )}
            {hasKey && !p.free && (
              <span className="text-xs px-1.5 py-0.5 rounded-full font-semibold" style={{ background: "color-mix(in srgb, var(--accent) 15%, var(--panel))", color: "var(--accent)" }}>
                Vault
              </span>
            )}
          </div>
          <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>{p.description}</p>
          <div className="flex flex-wrap gap-1 mt-2">
            {p.models.slice(0, 4).map((m) => (
              <span key={m.id} className="text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--paper)", border: "1px solid var(--line)", color: "var(--muted)" }}>
                {m.name}
              </span>
            ))}
            {p.models.length > 4 && <span className="text-xs py-0.5" style={{ color: "var(--muted)" }}>+{p.models.length - 4} more</span>}
          </div>
        </div>

        {!p.free && (
          <div className="shrink-0">
            {hasKey && !isEditing ? (
              <div className="flex items-center gap-2">
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  {new Date(vaultStatus.createdAt).toLocaleDateString()}
                </span>
                <button onClick={onStartEdit} className="text-xs font-semibold" style={{ color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}>Update</button>
                <button onClick={onRemove} disabled={saving} className="text-xs font-semibold" style={{ color: "var(--error)", background: "none", border: "none", cursor: "pointer" }}>Remove</button>
              </div>
            ) : !isEditing ? (
              <button onClick={onStartEdit} className="text-xs px-3 py-1.5 rounded-lg font-semibold" style={{ background: "var(--accent)", color: "white", border: "none", cursor: "pointer" }}>
                Add Key
              </button>
            ) : null}
          </div>
        )}
      </div>

      {isEditing && (
        <div className="mt-3">
          <input
            type="password"
            value={inputValue}
            onChange={(e) => onInputChange(e.target.value)}
            placeholder={p.keyPlaceholder}
            className="w-full p-2 rounded-lg border text-sm"
            style={{ background: "var(--paper)", borderColor: "var(--line)", color: "var(--ink)", fontFamily: "monospace" }}
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") onSave(); if (e.key === "Escape") onCancel(); }}
          />
          {error && <p className="text-xs mt-1" style={{ color: "var(--error)" }}>{error}</p>}
          <div className="flex gap-2 mt-2">
            <button onClick={onSave} disabled={saving || !inputValue.trim()} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white" style={{ background: "var(--accent)", border: "none", cursor: "pointer", opacity: saving || !inputValue.trim() ? 0.5 : 1 }}>
              {saving ? "Saving..." : "Save to vault"}
            </button>
            <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: "var(--panel)", border: "1px solid var(--line)", cursor: "pointer", color: "var(--ink)" }}>Cancel</button>
          </div>
        </div>
      )}

      {!p.free && (
        <a href={p.docsUrl} target="_blank" rel="noopener" className="text-xs mt-2 inline-block" style={{ color: "var(--accent)" }}>
          Get API key →
        </a>
      )}
    </div>
  );
}
