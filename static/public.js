const client = window.createLNbitsExtensionClient({extensionId: 'poker'})
const state = {
  gameId: '',
  game: null,
  player: null,
  response: null,
  selected: new Set(),
  qrApp: null,
  paymentUnsubscribe: null,
  paymentPollTimer: null,
  paymentHandledHash: '',
  websocket: null,
  pollTimer: null,
  rendering: false,
  renderQueued: false,
  settling: false,
  payoutAttemptKey: '',
  payoutRetryTimer: null,
  lastCelebrated: '',
  handRenderKey: '',
  nextHandTimer: null,
  nextHandKey: ''
}

const elements = {
  title: document.querySelector('#game-title'),
  opponentName: document.querySelector('#opponent-name'),
  opponentHand: document.querySelector('#opponent-hand'),
  opponentAction: document.querySelector('#opponent-action'),
  playerName: document.querySelector('#player-name'),
  playerHand: document.querySelector('#player-hand'),
  handHint: document.querySelector('#hand-hint'),
  turn: document.querySelector('#turn-badge'),
  pot: document.querySelector('#pot-value'),
  players: document.querySelector('#players-value'),
  handNumber: document.querySelector('#hand-number'),
  player1Score: document.querySelector('#player1-score'),
  player2Score: document.querySelector('#player2-score'),
  price: document.querySelector('#seat-price'),
  winner: document.querySelector('#winner-value'),
  cut: document.querySelector('#cut-value'),
  proof: document.querySelector('#proof-value'),
  result: document.querySelector('#result-title'),
  actions: document.querySelector('#action-list'),
  joinPanel: document.querySelector('#join-panel'),
  joinButton: document.querySelector('#join-button'),
  lnAddress: document.querySelector('#ln-address'),
  drawButton: document.querySelector('#draw-button'),
  foldButton: document.querySelector('#fold-button'),
  handResultOverlay: document.querySelector('#hand-result-overlay'),
  handResultKicker: document.querySelector('#hand-result-kicker'),
  handResultTitle: document.querySelector('#hand-result-title'),
  discard: document.querySelector('#discard-tray'),
  invoiceDialog: document.querySelector('#invoice-dialog'),
  invoiceQr: document.querySelector('#invoice-qr'),
  invoiceStatus: document.querySelector('#invoice-status'),
  copyInvoice: document.querySelector('#copy-invoice'),
  toast: document.querySelector('#toast'),
  confetti: document.querySelector('#confetti')
}

elements.joinButton.addEventListener('click', joinGame)
elements.drawButton.addEventListener('click', drawCards)
elements.foldButton.addEventListener('click', foldGame)
elements.discard.addEventListener('dragover', event => {
  event.preventDefault()
  elements.discard.classList.add('drag-over')
})
elements.discard.addEventListener('dragleave', () => elements.discard.classList.remove('drag-over'))
elements.discard.addEventListener('drop', event => {
  event.preventDefault()
  elements.discard.classList.remove('drag-over')
  const index = Number(event.dataTransfer.getData('text/card-index'))
  toggleCard(index, true)
})
document.querySelector('#copy-game').addEventListener('click', () => {
  copyText(publicUrl(), 'Invite link copied.')
})
elements.copyInvoice.addEventListener('click', () => {
  copyText(elements.copyInvoice.dataset.invoice || '', 'Invoice copied.')
})
document.querySelectorAll('[data-close-invoice]').forEach(button => {
  button.addEventListener('click', closeInvoice)
})

init().catch(showError)

async function init() {
  const context = await client.context()
  state.gameId = context.routeParams?.gameId || ''
  if (!state.gameId) throw new Error('No Poker table was selected.')
  await renderGame()
  window.addEventListener('beforeunload', cleanup)
}

async function renderGame() {
  if (state.rendering) {
    state.renderQueued = true
    return
  }
  state.rendering = true
  try {
    const response = await client.getPublicGame(state.gameId, playerToken())
    state.response = response
    state.game = response.game
    state.player = response.player
    renderStatus()
    renderHands()
    renderActions()
    scheduleAutomaticNextHand()
    await ensureWebsocket()
    if (
      state.player &&
      state.game.payoutPending &&
      ['completed', 'draw'].includes(state.game.status)
    ) {
      settlePayout(payoutKey(state.game))
    }
    const resultKey = `${state.game.completedAt}:${state.game.winnerSeat}`
    if (state.game.completedAt && state.lastCelebrated !== resultKey) {
      state.lastCelebrated = resultKey
      if (!state.game.winnerSeat || state.game.winnerSeat === state.player?.seat) celebrate()
    }
  } finally {
    state.rendering = false
    if (state.renderQueued) {
      state.renderQueued = false
      window.setTimeout(() => renderGame().catch(showError), 30)
    }
  }
}

function renderStatus() {
  const game = state.game
  const player = state.player
  elements.title.textContent = game.name
  elements.pot.textContent = `${game.potAmount.toLocaleString()} sats`
  elements.players.textContent = `${game.playersCount} / 2`
  elements.handNumber.textContent =
    `HAND ${game.handNumber} · FIRST TO ${game.matchTarget}`
  elements.player1Score.textContent = game.player1Score
  elements.player2Score.textContent = game.player2Score
  elements.price.textContent = game.joinAmount.toLocaleString()
  elements.winner.textContent = `${game.winnerPayout.toLocaleString()} sats`
  elements.cut.textContent = `${game.haircut}%`
  elements.joinPanel.hidden = !state.response.canJoin || !!player
  elements.playerName.textContent = player ? `${player.label} · You` : 'Spectating'
  elements.opponentName.textContent = opponentName()
  elements.result.textContent = game.resultLabel || statusText()
  elements.turn.textContent = statusText()
  elements.turn.className = `turn-badge turn-${game.status}`

  const isTurn = player && game.status === 'active' && game.turn === player.seat
  if (!isTurn && state.selected.size) state.selected.clear()
  elements.drawButton.hidden = !isTurn
  elements.foldButton.hidden = !isTurn
  const betweenHands = game.status === 'between-hands'
  elements.handResultOverlay.hidden = !betweenHands
  if (betweenHands) {
    elements.handResultKicker.textContent = `HAND ${game.handNumber} COMPLETE`
    elements.handResultTitle.textContent = game.winnerLnAddress
      ? `${game.winnerLnAddress} won the hand`
      : 'The hand is tied'
  }
  elements.drawButton.textContent = state.selected.size
    ? `Draw ${state.selected.size} card${state.selected.size === 1 ? '' : 's'}`
    : 'Stand pat'
  elements.handHint.textContent = handHint(isTurn)
  elements.discard.hidden = !isTurn
  elements.discard.classList.toggle('has-cards', state.selected.size > 0)
  elements.discard.querySelector('span').textContent = state.selected.size
    ? `${state.selected.size} selected · tap again to restore`
    : 'Tap cards or drag up to 3 here'

  if (game.revealedSeed) {
    elements.proof.textContent = `Revealed · ${shortHash(game.deckCommitment)}`
    elements.proof.title = `Seed: ${game.revealedSeed}\nCommitment: ${game.deckCommitment}`
  } else {
    elements.proof.textContent = `Committed · ${shortHash(game.deckCommitment)}`
    elements.proof.title = game.deckCommitment
  }
}

function renderHands() {
  let own = state.response.hand || []
  let opponentCards = state.response.opponentHand || []
  if (!state.player) {
    own = state.response.player1Hand || []
    opponentCards = state.response.player2Hand || []
    elements.playerName.textContent = 'Player 1'
    elements.opponentName.textContent = 'Player 2'
  }
  const interactive =
    !!state.player &&
    state.game.status === 'active' &&
    state.game.turn === state.player.seat
  const opponentSeat = state.player
    ? state.player.seat === 'player1' ? 'player2' : 'player1'
    : 'player2'
  const opponentPlayer = state.response.players.find(item => item.seat === opponentSeat)
  if (opponentPlayer?.drawn) {
    elements.opponentAction.hidden = false
    elements.opponentAction.textContent = opponentPlayer.discardCount
      ? `Drew ${opponentPlayer.discardCount}`
      : 'Stood pat'
  } else {
    elements.opponentAction.hidden = true
  }

  const renderKey = JSON.stringify({
    own,
    opponentCards,
    interactive
  })
  if (renderKey === state.handRenderKey) {
    syncSelectedCards(interactive)
    return
  }
  state.handRenderKey = renderKey
  renderCardRow(elements.playerHand, own, {interactive})
  renderCardRow(elements.opponentHand, opponentCards, {interactive: false})
}

function syncSelectedCards(interactive) {
  Array.from(elements.playerHand.children).forEach((node, index) => {
    node.classList.toggle(
      'selected',
      interactive && state.selected.has(index)
    )
  })
}

function renderCardRow(container, cards, {interactive}) {
  container.innerHTML = ''
  cards.forEach((card, index) => {
    const node = document.createElement(interactive ? 'button' : 'div')
    if (interactive) node.type = 'button'
    node.className = `playing-card ${card.hidden ? 'card-back' : suitClass(card.code)}`
    node.style.setProperty('--card-index', index)
    if (state.selected.has(index) && interactive) node.classList.add('selected')
    if (card.hidden) {
      node.innerHTML = '<div class="back-pattern">♠</div>'
      node.setAttribute('aria-label', 'Hidden card')
    } else {
      const rank = card.code[0] === 'T' ? '10' : card.code[0]
      const suit = suitGlyph(card.code[1])
      node.innerHTML = `
        <span class="card-corner top"><b>${rank}</b><i>${suit}</i></span>
        <span class="card-suit">${suit}</span>
        <span class="card-corner bottom"><b>${rank}</b><i>${suit}</i></span>`
      node.setAttribute('aria-label', `${rank} ${suitName(card.code[1])}`)
    }
    if (interactive) {
      node.draggable = true
      node.addEventListener('click', () => toggleCard(index))
      node.addEventListener('dragstart', event => {
        event.dataTransfer.setData('text/card-index', String(index))
        event.dataTransfer.effectAllowed = 'move'
        node.classList.add('dragging')
      })
      node.addEventListener('dragend', () => node.classList.remove('dragging'))
    }
    container.append(node)
  })
}

function toggleCard(index, selectOnly = false) {
  if (!Number.isInteger(index) || index < 0 || index > 4) return
  if (state.selected.has(index)) {
    if (!selectOnly) state.selected.delete(index)
  } else if (state.selected.size < 3) {
    state.selected.add(index)
  } else {
    toast('You can draw at most 3 cards.', 'warning')
  }
  renderStatus()
  renderHands()
}

function renderActions() {
  const actions = state.response.actions || []
  elements.actions.innerHTML = actions.map(action => {
    const text = action.type === 'draw'
      ? `drew ${action.cardsCount} card${action.cardsCount === 1 ? '' : 's'}`
      : action.type === 'stand-pat'
        ? 'stood pat'
        : action.type === 'fold'
          ? 'folded'
          : action.type === 'deal'
            ? 'dealt a fresh hand'
          : `showdown · ${action.handLabel}`
    return `<li><span>Hand ${action.handNumber} · ${escapeHtml(seatLabel(action.seat))}</span><strong>${escapeHtml(text)}</strong></li>`
  }).join('') || '<li class="empty-log">The dealer is shuffling…</li>'
}

async function joinGame() {
  const lnAddress = elements.lnAddress.value.trim()
  if (!lnAddress) return toast('Enter your Lightning address.', 'warning')
  setBusy(elements.joinButton, true, 'Creating invoice…')
  try {
    cleanupPaymentTracking()
    const invoice = await client.joinGame(state.gameId, {lnAddress})
    state.paymentHandledHash = ''
    savePlayerToken(invoice.paymentHash)
    openInvoice(invoice)
    subscribePayment(invoice.paymentHash)
    startPaymentPoll(invoice.paymentHash)
  } catch (error) {
    showError(error)
  } finally {
    setBusy(elements.joinButton, false, 'Pay & join')
  }
}

async function drawCards() {
  if (!state.player) return
  setBusy(elements.drawButton, true, 'Dealing…')
  try {
    const response = await client.drawCards(state.gameId, {
      playerToken: playerToken(),
      discardIndices: [...state.selected]
    })
    state.selected.clear()
    if (response.game?.payoutPending) settlePayout(payoutKey(response.game))
    await renderGame()
  } catch (error) {
    showError(error)
    await renderGame()
  } finally {
    setBusy(elements.drawButton, false, 'Draw cards')
  }
}

async function foldGame() {
  if (!window.confirm('Fold this hand and award one match point to your opponent?')) return
  setBusy(elements.foldButton, true, 'Folding…')
  try {
    const response = await client.fold(state.gameId, {playerToken: playerToken()})
    if (response.game?.payoutPending) settlePayout(payoutKey(response.game))
    await renderGame()
  } catch (error) {
    showError(error)
  } finally {
    setBusy(elements.foldButton, false, 'Fold')
  }
}

async function startNextHand() {
  if (!state.player) return
  try {
    await client.startNextHand(state.gameId, {
      playerToken: playerToken()
    })
    state.selected.clear()
    state.handRenderKey = ''
    await renderGame()
  } catch (error) {
    showError(error)
    await renderGame()
  }
}

function scheduleAutomaticNextHand() {
  const canAdvance = ['between-hands', 'dealing'].includes(state.game.status)
  if (!state.player || !canAdvance) {
    window.clearTimeout(state.nextHandTimer)
    state.nextHandTimer = null
    state.nextHandKey = ''
    return
  }
  const key =
    `${state.game.status}:${state.game.handNumber}:${state.game.updatedAt}`
  if (state.nextHandKey === key) return
  window.clearTimeout(state.nextHandTimer)
  state.nextHandKey = key
  const delay = state.game.status === 'dealing'
    ? state.player.seat === 'player1' ? 400 : 1400
    : state.player.seat === 'player1' ? 2400 : 3400
  state.nextHandTimer = window.setTimeout(() => {
    state.nextHandTimer = null
    startNextHand().catch(showError)
  }, delay)
}

async function settlePayout(attemptKey) {
  if (state.settling || !state.player) return
  if (state.payoutAttemptKey === attemptKey) return
  state.payoutAttemptKey = attemptKey
  state.settling = true
  window.clearTimeout(state.payoutRetryTimer)
  state.payoutRetryTimer = null
  try {
    const response = await client.settlePlayerPayout(state.gameId, {
      playerToken: playerToken()
    })
    if (response.payout?.ok && response.payout?.pending !== true) {
      toast('Payout sent over Lightning.', 'positive')
    } else if (response.payout?.pending === true) {
      schedulePayoutRetry(attemptKey)
    }
  } catch (error) {
    console.warn('[poker] payout pending owner retry', error)
    schedulePayoutRetry(attemptKey)
  } finally {
    state.settling = false
  }
}

function schedulePayoutRetry(attemptKey) {
  window.clearTimeout(state.payoutRetryTimer)
  state.payoutRetryTimer = window.setTimeout(() => {
    if (state.payoutAttemptKey === attemptKey) state.payoutAttemptKey = ''
    renderGame().catch(showError)
  }, 5000)
}

async function ensureWebsocket() {
  if (state.websocket) return
  try {
    state.websocket = await client.subscribeWebsocket(`game:${state.gameId}`, event => {
      if (event.event === 'websocket.error') {
        const failedSocket = state.websocket
        state.websocket = null
        failedSocket?.unsubscribe?.()
        startPolling()
        return
      }
      if (event.data?.type === 'server') renderGame().catch(showError)
    })
    stopPolling()
  } catch (error) {
    console.warn('[poker] live updates unavailable; polling continues', error)
    state.websocket = null
    startPolling()
  }
}

function startPolling() {
  if (state.pollTimer) return
  state.pollTimer = window.setInterval(() => {
    renderGame().catch(error => console.warn('[poker] fallback poll failed', error))
  }, 2500)
}

function stopPolling() {
  if (!state.pollTimer) return
  window.clearInterval(state.pollTimer)
  state.pollTimer = null
}

function openInvoice(invoice) {
  if (!invoice.paymentRequest || !invoice.paymentHash) throw new Error('Invalid invoice response.')
  elements.copyInvoice.dataset.invoice = invoice.paymentRequest
  elements.invoiceStatus.textContent = 'Waiting for Lightning payment…'
  renderQr(`lightning:${invoice.paymentRequest.toUpperCase()}`)
  elements.invoiceDialog.hidden = false
}

function closeInvoice() {
  elements.invoiceDialog.hidden = true
  cleanupPaymentTracking()
  if (state.qrApp) state.qrApp.unmount()
  state.qrApp = null
  elements.invoiceQr.innerHTML = ''
}

function renderQr(value) {
  if (!window.Vue || !window.QrcodeVue?.default) {
    elements.invoiceQr.textContent = 'Copy the invoice below to pay.'
    return
  }
  state.qrApp = window.Vue.createApp({
    render: () => window.Vue.h(window.QrcodeVue.default, {
      value,
      size: 250,
      margin: 3,
      level: 'Q',
      renderAs: 'svg'
    })
  })
  state.qrApp.mount(elements.invoiceQr)
}

async function subscribePayment(paymentHash) {
  state.paymentUnsubscribe?.()
  state.paymentUnsubscribe = null
  try {
    state.paymentUnsubscribe = await client.subscribePayment(paymentHash, event => {
      const payment = event.data || {}
      if (
        event.event === 'payment.settled' ||
        payment.pending === false ||
        ['success', 'settled', 'paid'].includes(String(payment.status || ''))
      ) {
        elements.invoiceStatus.textContent = 'Payment received — confirming your seat…'
        checkPaymentSeat(paymentHash).catch(() => {})
      }
    })
  } catch (error) {
    console.warn('[poker] payment subscription unavailable', error)
  }
}

function startPaymentPoll(paymentHash) {
  if (state.paymentPollTimer) window.clearInterval(state.paymentPollTimer)
  state.paymentPollTimer = window.setInterval(async () => {
    await checkPaymentSeat(paymentHash).catch(() => {})
  }, 2000)
}

async function checkPaymentSeat(paymentHash) {
  const response = await client.getPublicGame(state.gameId, paymentHash)
  if (response.player?.status === 'paid') {
    paymentReceived(paymentHash)
    return
  }
  if (response.paymentStatus === 'refunded') {
    paymentRefunded(paymentHash)
    return
  }
  if (['refund-pending', 'amount-mismatch'].includes(response.paymentStatus)) {
    elements.invoiceStatus.textContent =
      'Seat unavailable — your Lightning refund is pending.'
  }
}

function paymentReceived(paymentHash) {
  if (state.paymentHandledHash === paymentHash) return
  state.paymentHandledHash = paymentHash
  cleanupPaymentTracking()
  elements.invoiceStatus.textContent = 'Seat confirmed — cards are coming.'
  celebrate()
  window.setTimeout(() => {
    closeInvoice()
    renderGame().catch(showError)
  }, 1200)
}

function paymentRefunded(paymentHash) {
  if (state.paymentHandledHash === paymentHash) return
  state.paymentHandledHash = paymentHash
  cleanupPaymentTracking()
  elements.invoiceStatus.textContent = 'Seat unavailable — payment refunded.'
  window.setTimeout(() => {
    closeInvoice()
    renderGame().catch(showError)
  }, 2400)
}

function cleanupPaymentTracking() {
  state.paymentUnsubscribe?.()
  state.paymentUnsubscribe = null
  if (state.paymentPollTimer) {
    window.clearInterval(state.paymentPollTimer)
    state.paymentPollTimer = null
  }
}

function opponentName() {
  if (!state.player) {
    return state.response.players[1]?.label || 'Waiting for opponent'
  }
  const opponent = state.response.players.find(item => item.seat !== state.player.seat)
  return opponent ? `${opponent.label} · ${opponent.lnAddress}` : 'Waiting for opponent'
}

function statusText() {
  const game = state.game
  if (game.status === 'waiting') {
    return game.playersCount ? 'One more player needed' : 'Table open'
  }
  if (game.status === 'completed' || game.status === 'draw') {
    return game.resultLabel || 'Match complete'
  }
  if (game.status === 'between-hands') return game.resultLabel || 'Hand complete'
  if (game.status === 'dealing') return 'Dealer is shuffling'
  if (!state.player) return `${seatLabel(game.turn)} to draw`
  return game.turn === state.player.seat ? 'Your draw' : 'Opponent is choosing'
}

function handHint(isTurn) {
  if (!state.player) {
    return state.response.canJoin
      ? 'Join to receive a private hand'
      : 'Private cards stay hidden until showdown'
  }
  if (['completed', 'draw'].includes(state.game.status)) return 'Match complete · hands revealed'
  if (state.game.status === 'between-hands') return 'Hands revealed · next hand is shuffling'
  if (state.game.status === 'dealing') return 'A fresh deck is being shuffled'
  if (state.game.status === 'waiting') return 'Your cards arrive when the second seat pays'
  if (isTurn) return 'Keep what you like. Replace up to three.'
  if (state.game[`${state.player.seat === 'player1' ? 'player1' : 'player2'}Drawn`]) {
    return 'Your draw is locked in'
  }
  return 'Waiting for the first hand'
}

function suitGlyph(suit) {
  return {S: '♠', H: '♥', D: '♦', C: '♣'}[suit] || ''
}

function suitName(suit) {
  return {S: 'of spades', H: 'of hearts', D: 'of diamonds', C: 'of clubs'}[suit] || ''
}

function suitClass(code) {
  return ['H', 'D'].includes(code?.[1]) ? 'red-suit' : 'black-suit'
}

function seatLabel(seat) {
  return seat === 'player1' ? 'Player 1' : seat === 'player2' ? 'Player 2' : 'Dealer'
}

function playerToken() {
  return state.player?.id || tokenFromUrl()
}

function tokenFromUrl() {
  return new URLSearchParams(window.location.hash.slice(1)).get('player') || ''
}

function savePlayerToken(token) {
  const url = new URL(window.location.href)
  url.hash = new URLSearchParams({player: token}).toString()
  window.history.replaceState(null, '', url)
}

function publicUrl() {
  const url = new URL(window.location.href)
  url.hash = ''
  return url.href
}

async function copyText(value, message) {
  try {
    await navigator.clipboard.writeText(value)
    toast(message, 'positive')
  } catch (_) {
    toast('Copy failed. Select the text manually.', 'warning')
  }
}

function setBusy(button, busy, label) {
  button.disabled = busy
  button.textContent = label
}

function toast(message, level = 'info') {
  elements.toast.textContent = message
  elements.toast.className = `toast toast-${level}`
  elements.toast.hidden = false
  window.clearTimeout(toast.timer)
  toast.timer = window.setTimeout(() => {
    elements.toast.hidden = true
  }, 3200)
}

function showError(error) {
  console.error('[poker]', error)
  toast(error.message || String(error), 'negative')
}

function celebrate() {
  elements.confetti.innerHTML = ''
  const colors = ['#f6c453', '#ec4f5e', '#40c79a', '#f5eee0']
  for (let index = 0; index < 48; index += 1) {
    const piece = document.createElement('i')
    piece.style.left = `${Math.random() * 100}%`
    piece.style.background = colors[index % colors.length]
    piece.style.animationDelay = `${Math.random() * 0.7}s`
    piece.style.setProperty('--drift', `${Math.random() * 180 - 90}px`)
    elements.confetti.append(piece)
  }
  window.setTimeout(() => { elements.confetti.innerHTML = '' }, 3500)
}

function shortHash(value) {
  return value ? `${value.slice(0, 7)}…${value.slice(-5)}` : '—'
}

function payoutKey(game) {
  return `${game.id}:${game.completedAt || game.updatedAt || ''}`
}

function cleanup() {
  stopPolling()
  cleanupPaymentTracking()
  window.clearTimeout(state.payoutRetryTimer)
  state.payoutRetryTimer = null
  window.clearTimeout(state.nextHandTimer)
  state.nextHandTimer = null
  state.websocket?.unsubscribe?.()
}

function escapeHtml(value) {
  const node = document.createElement('div')
  node.textContent = String(value ?? '')
  return node.innerHTML
}
