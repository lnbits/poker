const client = window.createLNbitsExtensionClient({extensionId: 'poker'})
const enabledInput = document.querySelector('#enabled-input')
const walletInput = document.querySelector('#wallet-input')
const haircutInput = document.querySelector('#haircut-input')
const nameInput = document.querySelector('#name-input')
const amountInput = document.querySelector('#amount-input')
const gameRows = document.querySelector('#game-rows')

document.querySelector('#save-settings').addEventListener('click', saveSettings)
document.querySelector('#create-game').addEventListener('click', createGame)
document.querySelector('#refresh-games').addEventListener('click', loadGames)
init().catch(showError)

async function init() {
  const [wallets, settings] = await Promise.all([client.listWallets(), client.getSettings()])
  walletInput.innerHTML = (wallets.wallets || [])
    .map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`)
    .join('')
  const value = settings.settings || {}
  enabledInput.checked = value.enabled === true
  haircutInput.value = value.haircut || 0
  if (value.walletId) walletInput.value = value.walletId
  await loadGames()
}

async function saveSettings() {
  try {
    await client.saveSettings({
      enabled: enabledInput.checked,
      walletId: walletInput.value,
      walletName: walletInput.selectedOptions[0]?.textContent || '',
      haircut: Number(haircutInput.value)
    })
    notify('Poker settings saved.', 'positive')
  } catch (error) {
    showError(error)
  }
}

async function createGame() {
  const amount = Number(amountInput.value)
  if (!Number.isInteger(amount) || amount < 20) {
    showError(new Error('Seat price must be at least 20 sats.'))
    return
  }
  try {
    await client.requestBackgroundPaymentPermission({
      walletId: walletInput.value,
      maxAmount: amount * 2,
      destinationPolicy: 'external_allowed'
    })
    await client.createGame({name: nameInput.value, joinAmount: amount})
    notify('Poker table opened.', 'positive')
    await loadGames()
  } catch (error) {
    showError(error)
  }
}

async function loadGames() {
  try {
    const response = await client.listGames({
      page: 1,
      rowsPerPage: 50,
      sortBy: 'createdAt',
      descending: true
    })
    gameRows.innerHTML = (response.games || []).map(game => `
      <tr>
        <td><strong>${escapeHtml(game.name)}</strong><small>${escapeHtml(game.resultLabel || '')}</small></td>
        <td>${game.joinAmount.toLocaleString()} sats</td>
        <td>${game.playersCount} / 2<small>Score ${game.player1Score}–${game.player2Score} · first to ${game.matchTarget}</small></td>
        <td><span class="status-pill status-${escapeHtml(game.status)}">${statusLabel(game)}</span></td>
        <td class="row-actions">
          <button data-copy="${escapeHtml(game.id)}" class="ghost-button">Copy link</button>
          ${game.payoutPending ? `<button data-settle="${escapeHtml(game.id)}" class="ghost-button">Settle</button>` : ''}
          ${canDelete(game) ? `<button data-delete="${escapeHtml(game.id)}" class="danger-link">Delete</button>` : ''}
        </td>
      </tr>`).join('') || '<tr><td colspan="5" class="empty-row">No tables yet.</td></tr>'
    gameRows.querySelectorAll('[data-copy]').forEach(button => {
      button.addEventListener('click', () => copyGameLink(button.dataset.copy))
    })
    gameRows.querySelectorAll('[data-settle]').forEach(button => {
      button.addEventListener('click', () => settleGame(button.dataset.settle))
    })
    gameRows.querySelectorAll('[data-delete]').forEach(button => {
      button.addEventListener('click', () => deleteGame(button.dataset.delete))
    })
  } catch (error) {
    showError(error)
  }
}

async function settleGame(id) {
  try {
    await client.settleGame(id)
    notify('Payout processed.', 'positive')
    await loadGames()
  } catch (error) {
    showError(error)
  }
}

async function deleteGame(id) {
  if (!window.confirm('Delete this Poker table and its hand history?')) return
  try {
    await client.deleteGame(id)
    notify('Poker table deleted.', 'positive')
    await loadGames()
  } catch (error) {
    showError(error)
  }
}

function publicUrl(id) {
  return new URL(`/ext/poker/games/${encodeURIComponent(id)}`, window.location.href).href
}

async function copyGameLink(id) {
  const url = publicUrl(id)
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url)
    } else {
      const input = document.createElement('textarea')
      input.value = url
      input.setAttribute('readonly', '')
      input.style.position = 'fixed'
      input.style.opacity = '0'
      document.body.append(input)
      input.select()
      const copied = document.execCommand('copy')
      input.remove()
      if (!copied) throw new Error('Clipboard copy was rejected.')
    }
    notify('Game link copied.', 'positive')
  } catch (error) {
    showError(error)
  }
}

function statusLabel(game) {
  if (game.payoutPending) return 'Payout pending'
  if (game.status === 'draw') return 'Split pot'
  if (game.status === 'between-hands') return 'Between hands'
  return game.status[0].toUpperCase() + game.status.slice(1)
}

function canDelete(game) {
  if (game.payoutPending) return false
  if (!game.playersCount) return true
  return ['completed', 'draw'].includes(game.status)
}

function notify(message, level = 'info') {
  client.notify(message, level).catch(() => {})
}

function showError(error) {
  console.error('[poker admin]', error)
  notify(error.message || String(error), 'negative')
}

function escapeHtml(value) {
  const node = document.createElement('div')
  node.textContent = String(value ?? '')
  return node.innerHTML
}
