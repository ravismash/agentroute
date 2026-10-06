// Operator approval dashboard. No framework, no build step.
// All server data is rendered with textContent (never innerHTML).

const TOKEN_KEY = "agentroute.operatorToken";
const $ = (id) => document.getElementById(id);

let token = null;
try {
  token = sessionStorage.getItem(TOKEN_KEY);
} catch {
  /* storage unavailable: token lives in memory only */
}

const statusEl = $("status");
const tbody = document.querySelector("#queue tbody");
const template = $("row-template");

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function money(amountMinor, currency) {
  if (amountMinor === null || currency === null) return "—";
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountMinor / 100);
}

function time(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.detail || body.title || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function render(items) {
  tbody.replaceChildren();
  $("queue").hidden = items.length === 0;
  $("empty").hidden = items.length !== 0;
  for (const item of items) {
    const row = template.content.firstElementChild.cloneNode(true);
    const field = (name) => row.querySelector(`[data-field="${name}"]`);
    field("requested").textContent = time(item.requested_at);
    field("customer").textContent = item.customer_id;
    field("case").textContent = `${item.case_id} · ${item.tenant_id}`;
    field("tool").textContent = item.tool;
    field("agent").textContent = item.agent_id;
    field("amount").textContent = money(item.amount_minor, item.currency);
    field("expires").textContent = time(item.expires_at);
    for (const reason of item.reasons) {
      const li = document.createElement("li");
      li.textContent = reason.message;
      li.title = `${reason.code}${reason.rule_id ? ` · ${reason.rule_id}` : ""}`;
      field("reasons").append(li);
    }
    const note = row.querySelector("input");
    for (const button of row.querySelectorAll("button[data-decision]")) {
      button.addEventListener("click", () =>
        decide(item.action_id, button.dataset.decision, note.value, row),
      );
    }
    tbody.append(row);
  }
}

async function load() {
  if (!token) return;
  setStatus("Loading…");
  try {
    const page = await api("/v1/approvals?limit=100");
    render(page.items);
    setStatus(`${page.items.length} pending · updated ${new Date().toLocaleTimeString()}`);
    $("refresh").disabled = false;
    $("sign-out").hidden = false;
  } catch (error) {
    if (error.status === 401) signOut("Token rejected. Paste a valid operator token.");
    else setStatus(`Could not load approvals: ${error.message}`, true);
  }
}

async function decide(actionId, decision, note, row) {
  for (const b of row.querySelectorAll("button")) b.disabled = true;
  try {
    const view = await api(`/v1/approvals/${encodeURIComponent(actionId)}/${decision}`, {
      method: "POST",
      body: JSON.stringify(note.trim() ? { note: note.trim() } : {}),
    });
    setStatus(`${decision === "approve" ? "Approved" : "Rejected"} ${actionId.slice(0, 8)}… → ${view.state}`);
  } catch (error) {
    setStatus(`Decision failed: ${error.message}`, true);
  }
  await load();
}

function signOut(message = "Signed out.") {
  token = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  tbody.replaceChildren();
  $("queue").hidden = true;
  $("empty").hidden = true;
  $("refresh").disabled = true;
  $("sign-out").hidden = true;
  setStatus(message);
}

$("token-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = $("token").value.trim();
  if (!value) return;
  token = value;
  $("token").value = "";
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore */
  }
  void load();
});
$("refresh").addEventListener("click", () => void load());
$("sign-out").addEventListener("click", () => signOut());

void load();
