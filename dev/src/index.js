import {storage, system, wallet, websocket} from './lnbits-sdk.js'

const SETTINGS_TABLE = 'poker_settings'
const GAMES_TABLE = 'poker_games'
const PLAYERS_TABLE = 'poker_players'
const SECRETS_TABLE = 'poker_secrets'
const ACTIONS_TABLE = 'poker_actions'
const SETTINGS_ID = 'poker-settings'
const MIN_JOIN_SATS = 20
const MAX_JOIN_SATS = 100000000
const MAX_DISCARDS = 3
const GAME_SEARCH_FIELDS = ['name', 'winner_ln_address', 'status']
const RANKS = '23456789TJQKA'
const SUITS = 'SHDC'
const RANK_NAMES = {
  2: 'Twos',
  3: 'Threes',
  4: 'Fours',
  5: 'Fives',
  6: 'Sixes',
  7: 'Sevens',
  8: 'Eights',
  9: 'Nines',
  10: 'Tens',
  11: 'Jacks',
  12: 'Queens',
  13: 'Kings',
  14: 'Aces'
}

export function getPokerSettings(_requestJson) {
  return runJson(() => ({settings: publicSettings(getSettings())}))
}

export function savePokerSettings(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const existing = getSettings()
    const now = system.now()
    const walletId = cleanText(request.walletId ?? request.wallet_id, 128)
    const settings = {
      id: SETTINGS_ID,
      wallet_id: walletId,
      wallet_name: cleanText(request.walletName ?? request.wallet_name, 120) || walletId,
      enabled: request.enabled === true,
      haircut: normalizePercent(request.haircut, 0),
      created_at: existing.created_at || now,
      updated_at: now
    }
    if (settings.enabled && !settings.wallet_id) {
      throw new Error('walletId is required when Poker games are enabled.')
    }
    storage.set(SETTINGS_TABLE, settings)
    return {settings: publicSettings(settings)}
  })
}

export function listPokerWallets(_requestJson) {
  return runJson(() => ({wallets: wallet.listUserWallets()}))
}

export function createPokerGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const settings = getSettings()
    if (!settings.enabled) throw new Error('Poker games are disabled.')
    if (!settings.wallet_id) throw new Error('Poker wallet is not configured.')

    const now = system.now()
    const id = cleanId(request.id) || system.id('poker')
    if (storage.get(GAMES_TABLE, id, null)) {
      throw new Error('A Poker game with that id already exists.')
    }
    const seed = `${system.id('deck')}:${system.id('seed')}`
    if (!seed) throw new Error('Could not create a secure deck.')
    const deckCommitment = sha256(seed)
    const game = {
      id,
      settings_id: settings.id,
      wallet_id: settings.wallet_id,
      name: cleanText(request.name, 80) || 'Heads-up draw poker',
      join_amount: normalizeInteger(
        request.joinAmount ?? request.join_amount,
        100,
        MIN_JOIN_SATS,
        MAX_JOIN_SATS
      ),
      haircut: Number(settings.haircut || 0),
      players_count: 0,
      status: 'waiting',
      match_target: normalizeMatchTarget(
        request.matchTarget ?? request.match_target
      ),
      hand_number: 1,
      player1_score: 0,
      player2_score: 0,
      player1_ln_address: '',
      player2_ln_address: '',
      player1_payment_hash: '',
      player2_payment_hash: '',
      turn: 'player1',
      player1_drawn: false,
      player2_drawn: false,
      player1_discard_count: 0,
      player2_discard_count: 0,
      winner_seat: '',
      winner_ln_address: '',
      result_label: '',
      payout_pending: false,
      payout_status: '',
      player1_payout_status: '',
      player2_payout_status: '',
      player1_payout_payment_hash: '',
      player2_payout_payment_hash: '',
      deck_commitment: deckCommitment,
      action_count: 0,
      created_at: now,
      updated_at: now,
      started_at: null,
      completed_at: null
    }
    const deck = shuffledDeck(seed, deckCommitment)
    storage.set(SECRETS_TABLE, {
      id,
      game_id: id,
      seed,
      deck_json: JSON.stringify(deck),
      player1_hand_json: '[]',
      player2_hand_json: '[]',
      deck_position: 0,
      created_at: now,
      updated_at: now
    })
    storage.set(GAMES_TABLE, game)
    system.log(`poker: created game ${id}`)
    return {game: publicGame(game), publicUrl: `/poker/games/${id}`}
  })
}

export function listPokerGames(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const rowsPerPage = normalizePageSize(request.rowsPerPage)
    const page = normalizePage(request.page)
    const response = storage.getPaginated(GAMES_TABLE, {
      search: cleanText(request.search, 256),
      searchFields: GAME_SEARCH_FIELDS,
      sortBy: normalizeGameSortBy(request.sortBy),
      descending: request.descending === true || request.descending === 'true',
      limit: rowsPerPage,
      offset: (page - 1) * rowsPerPage
    })
    return {games: response.data.map(publicGame), total: response.total}
  })
}

export function deletePokerGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const gameId = requiredText(request.gameId, 'gameId', 128)
    const game = getGame(gameId)
    if (game.payout_pending === true) {
      throw new Error('Settle the pending payout before deleting this Poker game.')
    }
    if (
      Number(game.players_count || 0) > 0 &&
      !['completed', 'draw'].includes(game.status)
    ) {
      throw new Error('A funded Poker game cannot be deleted before it finishes.')
    }
    for (let number = 1; number <= Number(game.action_count || 0); number += 1) {
      storage.delete(ACTIONS_TABLE, `${gameId}-${number}`)
    }
    deletePlayerRecords(gameId)
    storage.delete(SECRETS_TABLE, gameId)
    storage.delete(GAMES_TABLE, gameId)
    return {deleted: true, gameId}
  })
}

export function getPublicPokerGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const game = getGame(requiredText(request.gameId, 'gameId', 128))
    const player = playerForToken(
      game,
      cleanText(request.playerToken ?? request.player_token, 128)
    )
    const paymentToken = cleanText(
      request.playerToken ?? request.player_token,
      128
    )
    const payment = paymentToken
      ? storage.get(PLAYERS_TABLE, paymentToken, null)
      : null
    const secrets = getSecrets(game.id)
    const showAll = ['between-hands', 'completed', 'draw'].includes(game.status)
    const player1Hand = parseCards(secrets.player1_hand_json)
    const player2Hand = parseCards(secrets.player2_hand_json)
    return {
      game: publicGame(game, showAll ? secrets.seed : ''),
      players: publicPlayers(game),
      player: player ? publicPlayer(player, true) : null,
      paymentStatus:
        payment?.game_id === game.id ? payment.status || 'pending' : '',
      hand: player
        ? publicHand(player.seat === 'player1' ? player1Hand : player2Hand, true)
        : [],
      opponentHand: showAll
        ? publicHand(player?.seat === 'player1' ? player2Hand : player1Hand, true)
        : hiddenHand(game.players_count > 1 ? 5 : 0),
      player1Hand: showAll ? publicHand(player1Hand, true) : hiddenHand(player1Hand.length),
      player2Hand: showAll ? publicHand(player2Hand, true) : hiddenHand(player2Hand.length),
      actions: publicActions(game),
      canJoin: game.status === 'waiting' && Number(game.players_count || 0) < 2
    }
  })
}

export function joinPokerGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const game = getGame(requiredText(request.gameId, 'gameId', 128))
    const lnAddress = normalizeLnAddress(request.lnAddress ?? request.ln_address)
    if (game.status !== 'waiting') throw new Error('This Poker hand has already started.')
    if (Number(game.players_count || 0) >= 2) throw new Error('This Poker table is full.')
    if (
      [game.player1_ln_address, game.player2_ln_address]
        .filter(Boolean)
        .includes(lnAddress)
    ) {
      throw new Error('That Lightning address already has a seat.')
    }
    const invoice = wallet.createInvoicePublic({
      sourceId: game.id,
      amount: Number(game.join_amount),
      memo: `Poker seat at ${game.name}`,
      extra: {game_id: game.id, ln_address: lnAddress}
    })
    return {
      paymentHash: invoice.paymentHash,
      paymentRequest: invoice.paymentRequest,
      checkingId: invoice.checkingId
    }
  })
}

export function recordPokerPayment(eventJson) {
  return runJson(() => {
    const event = parseJsonObject(eventJson)
    const paymentHash = eventPaymentHash(event)
    const extensionExtra =
      event.extra?.extra_poker || event.payment?.extra?.extra_poker || {}
    const gameId = cleanText(
      extensionExtra.game_id || event.extra?.game_id || event.payment?.extra?.game_id,
      128
    )
    const lnAddress = normalizeLnAddress(
      extensionExtra.ln_address ||
        event.extra?.ln_address ||
        event.payment?.extra?.ln_address
    )
    if (!paymentHash) throw new Error('paymentHash is required.')
    if (!gameId) throw new Error('game_id is required.')

    const game = getGame(gameId)
    const paidMsat = Math.abs(Number(event.amount ?? event.payment?.amount ?? 0))
    const paidSat = Number.isSafeInteger(paidMsat) ? Math.floor(paidMsat / 1000) : 0
    const expectedMsat = Number(game.join_amount) * 1000
    const existing = storage.get(PLAYERS_TABLE, paymentHash, null)
    if (existing) {
      if (existing.status === 'paid') {
        const recovered = seatPaidPlayer(getGame(gameId), existing)
        return {
          game: publicGame(recovered.game),
          player: publicPlayer(recovered.player, true),
          status: recovered.player.status,
          ...(recovered.refund ? {refund: recovered.refund} : {})
        }
      }
      if (['refund-pending', 'amount-mismatch'].includes(existing.status)) {
        const retried = retryPlayerRefund(game, existing, paidSat)
        return {
          game: publicGame(game),
          player: publicPlayer(retried.player, true),
          status: retried.player.status,
          refund: retried.refund
        }
      }
      return {
        game: publicGame(game),
        player: publicPlayer(existing, true),
        status: existing.status
      }
    }
    if (!Number.isSafeInteger(paidMsat) || paidMsat !== expectedMsat) {
      const player = markPlayer(paymentHash, gameId, lnAddress, '', 'amount-mismatch')
      const refund = refundPlayer(game, lnAddress, paidSat, 'amount-mismatch')
      if (refund.ok) {
        player.status = 'refunded'
        storage.set(PLAYERS_TABLE, player)
      }
      return {game: publicGame(game), player: publicPlayer(player, true), status: player.status, refund}
    }
    if (
      game.status !== 'waiting' ||
      Number(game.players_count || 0) >= 2 ||
      [game.player1_ln_address, game.player2_ln_address].filter(Boolean).includes(lnAddress)
    ) {
      const player = markPlayer(paymentHash, gameId, lnAddress, '', 'refund-pending')
      const refund = refundPlayer(game, lnAddress, paidSat, 'seat-unavailable')
      if (refund.ok) {
        player.status = 'refunded'
        storage.set(PLAYERS_TABLE, player)
      }
      return {game: publicGame(game), player: publicPlayer(player, true), status: player.status, refund}
    }

    const seat = Number(game.players_count || 0) === 0 ? 'player1' : 'player2'
    const player = markPlayer(paymentHash, gameId, lnAddress, seat, 'paid')
    const seated = seatPaidPlayer(getGame(gameId), player)
    return {
      game: publicGame(seated.game),
      player: publicPlayer(seated.player, true),
      status: seated.player.status,
      ...(seated.refund ? {refund: seated.refund} : {})
    }
  })
}

export function drawPokerCards(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const game = getGame(requiredText(request.gameId, 'gameId', 128))
    const player = requirePlayer(
      game,
      requiredText(request.playerToken ?? request.player_token, 'playerToken', 128)
    )
    if (game.status !== 'active') throw new Error('This Poker hand is not active.')
    if (game.turn !== player.seat) throw new Error(`It is ${seatLabel(game.turn)}'s turn.`)
    if (game[`${player.seat}_drawn`] === true) throw new Error('You have already drawn.')

    const indices = normalizeDiscardIndices(request.discardIndices ?? request.discard_indices)
    const secrets = getSecrets(game.id)
    const handField = `${player.seat}_hand_json`
    const hand = parseCards(secrets[handField])
    if (hand.length !== 5) throw new Error('Your hand is unavailable.')
    const deck = parseCards(secrets.deck_json)
    let deckPosition = Number(secrets.deck_position || 0)
    const nextHand = [...hand]
    for (const index of indices) {
      if (!deck[deckPosition]) throw new Error('The deck does not have enough cards.')
      nextHand[index] = deck[deckPosition]
      deckPosition += 1
    }
    storage.set(SECRETS_TABLE, {
      ...secrets,
      [handField]: JSON.stringify(nextHand),
      deck_position: deckPosition,
      updated_at: system.now()
    })

    const starter = startingSeat(game)
    const isLastDraw = player.seat !== starter
    let updatedGame = {
      ...game,
      [`${player.seat}_drawn`]: true,
      [`${player.seat}_discard_count`]: indices.length,
      turn: isLastDraw ? 'showdown' : oppositeSeat(player.seat),
      updated_at: system.now()
    }
    updatedGame = recordAction(
      updatedGame,
      player.seat,
      indices.length ? 'draw' : 'stand-pat',
      indices.length,
      ''
    )
    if (isLastDraw) updatedGame = completeShowdown(updatedGame)
    storage.set(GAMES_TABLE, updatedGame)
    publishGame(updatedGame, isLastDraw ? 'showdown' : 'draw')
    return {
      game: publicGame(
        updatedGame,
        ['between-hands', 'completed', 'draw'].includes(updatedGame.status)
          ? secrets.seed
          : ''
      ),
      hand: publicHand(nextHand, true),
      player: publicPlayer(player, true),
      payout: {ok: true, pending: updatedGame.payout_pending === true}
    }
  })
}

export function foldPokerGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const game = getGame(requiredText(request.gameId, 'gameId', 128))
    const player = requirePlayer(
      game,
      requiredText(request.playerToken ?? request.player_token, 'playerToken', 128)
    )
    if (game.status !== 'active') throw new Error('Only an active Poker hand can be folded.')
    if (game.turn !== player.seat) throw new Error(`It is ${seatLabel(game.turn)}'s turn.`)
    const winnerSeat = oppositeSeat(player.seat)
    let updatedGame = {...game, updated_at: system.now()}
    updatedGame = recordAction(updatedGame, player.seat, 'fold', 0, '')
    updatedGame = completeHand(
      updatedGame,
      winnerSeat,
      `${seatLabel(player.seat)} folded`
    )
    storage.set(GAMES_TABLE, updatedGame)
    publishGame(updatedGame, 'fold')
    return {
      game: publicGame(updatedGame, getSecrets(game.id).seed),
      payout: {ok: true, pending: updatedGame.payout_pending === true}
    }
  })
}

export function startNextPokerHand(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const game = getGame(requiredText(request.gameId, 'gameId', 128))
    const player = requirePlayer(
      game,
      requiredText(request.playerToken ?? request.player_token, 'playerToken', 128)
    )
    if (matchTarget(game) <= 1) {
      throw new Error('This table is configured for a single hand.')
    }
    if (game.status === 'active') {
      return {
        game: publicGame(game),
        hand: playerHand(game, player.seat),
        player: publicPlayer(player, true),
        started: false
      }
    }
    const resumingDeal = game.status === 'dealing'
    if (!resumingDeal && game.status !== 'between-hands') {
      throw new Error('The current Poker hand must finish before dealing again.')
    }

    const nextHandNumber = resumingDeal
      ? handNumber(game)
      : handNumber(game) + 1
    const now = system.now()
    if (!resumingDeal) {
      storage.set(GAMES_TABLE, {
        ...game,
        status: 'dealing',
        hand_number: nextHandNumber,
        updated_at: now
      })
    }

    const seed = `${system.id('deck')}:${system.id('seed')}`
    if (!seed) throw new Error('Could not create a secure deck.')
    const deckCommitment = sha256(seed)
    const deck = shuffledDeck(seed, deckCommitment)
    const previousSecrets = getSecrets(game.id)
    storage.set(SECRETS_TABLE, {
      ...previousSecrets,
      seed,
      deck_json: JSON.stringify(deck),
      player1_hand_json: JSON.stringify(deck.slice(0, 5)),
      player2_hand_json: JSON.stringify(deck.slice(5, 10)),
      deck_position: 10,
      updated_at: now
    })
    let updatedGame = {
      ...getGame(game.id),
      status: 'active',
      turn: startingSeat(nextHandNumber),
      player1_drawn: false,
      player2_drawn: false,
      player1_discard_count: 0,
      player2_discard_count: 0,
      winner_seat: '',
      winner_ln_address: '',
      result_label: '',
      payout_pending: false,
      payout_status: '',
      player1_payout_status: '',
      player2_payout_status: '',
      player1_payout_payment_hash: '',
      player2_payout_payment_hash: '',
      deck_commitment: deckCommitment,
      completed_at: null,
      updated_at: now
    }
    updatedGame = recordAction(
      updatedGame,
      'dealer',
      'deal',
      0,
      `Hand ${nextHandNumber}`
    )
    storage.set(GAMES_TABLE, updatedGame)
    publishGame(updatedGame, 'next-hand')
    return {
      game: publicGame(updatedGame),
      hand: playerHand(updatedGame, player.seat),
      player: publicPlayer(player, true),
      started: true
    }
  })
}

export function settlePlayerPokerPayout(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const game = getGame(requiredText(request.gameId, 'gameId', 128))
    requirePlayer(
      game,
      requiredText(request.playerToken ?? request.player_token, 'playerToken', 128)
    )
    if (!['completed', 'draw'].includes(game.status)) {
      throw new Error('Only a finished Poker hand can be settled.')
    }
    if (!game.payout_pending) {
      return {game: publicGame(game, getSecrets(game.id).seed), payout: {ok: true, pending: false, alreadySettled: true}}
    }
    const settlement = settlePayouts(game)
    return {game: publicGame(settlement.game, getSecrets(game.id).seed), payout: settlement.payout}
  })
}

export function settlePokerGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const game = getGame(requiredText(request.gameId, 'gameId', 128))
    if (!['completed', 'draw'].includes(game.status)) {
      throw new Error('Only a finished Poker hand can be settled.')
    }
    if (!game.payout_pending) throw new Error('This Poker hand is already settled.')
    const settlement = settlePayouts(game)
    return {game: publicGame(settlement.game, getSecrets(game.id).seed), payout: settlement.payout}
  })
}

function completeShowdown(game) {
  const secrets = getSecrets(game.id)
  const first = evaluateHand(parseCards(secrets.player1_hand_json))
  const second = evaluateHand(parseCards(secrets.player2_hand_json))
  const comparison = compareScores(first.score, second.score)
  const winnerSeat = comparison > 0 ? 'player1' : comparison < 0 ? 'player2' : ''
  const handResult = winnerSeat
    ? `${seatLabel(winnerSeat)} wins with ${
        winnerSeat === 'player1' ? first.label : second.label
      }`
    : `Tie — both have ${first.label}`
  let result = completeHand(game, winnerSeat, handResult)
  result = recordAction(
    result,
    'dealer',
    'showdown',
    0,
    `${first.label} vs ${second.label}`
  )
  return result
}

function completeHand(game, handWinnerSeat, handResult) {
  const target = matchTarget(game)
  const firstScore =
    Number(game.player1_score || 0) + Number(handWinnerSeat === 'player1')
  const secondScore =
    Number(game.player2_score || 0) + Number(handWinnerSeat === 'player2')
  const matchWinner =
    firstScore >= target
      ? 'player1'
      : secondScore >= target
        ? 'player2'
        : ''
  const legacyDraw = target === 1 && !handWinnerSeat
  const matchFinished = Boolean(matchWinner) || legacyDraw
  const now = system.now()
  const score = `${firstScore}–${secondScore}`
  const showdownPrefix = `${seatLabel(matchWinner)} wins with `
  const finalHandDetail = handResult.startsWith(showdownPrefix)
    ? ` with ${handResult.slice(showdownPrefix.length)}`
    : ` · ${handResult}`
  const resultLabel =
    target === 1
      ? handWinnerSeat
        ? handResult
        : `Split pot — both have ${handResult.replace('Tie — both have ', '')}`
      : matchWinner
        ? `${seatLabel(matchWinner)} wins the match ${score}${finalHandDetail}`
        : `Hand ${handNumber(game)} · ${handResult} · Match ${score}`

  return {
    ...game,
    status: matchFinished
      ? matchWinner
        ? 'completed'
        : 'draw'
      : 'between-hands',
    turn: '',
    player1_score: firstScore,
    player2_score: secondScore,
    winner_seat: matchWinner || (!matchFinished ? handWinnerSeat : ''),
    winner_ln_address: matchWinner || (!matchFinished ? handWinnerSeat : '')
      ? game[`${matchWinner || handWinnerSeat}_ln_address`]
      : '',
    result_label: resultLabel,
    payout_pending: matchFinished,
    payout_status: matchFinished ? 'pending' : '',
    player1_payout_status:
      matchFinished && matchWinner !== 'player2' ? 'pending' : '',
    player2_payout_status:
      matchFinished && matchWinner !== 'player1' ? 'pending' : '',
    player1_payout_payment_hash: '',
    player2_payout_payment_hash: '',
    updated_at: now,
    completed_at: matchFinished ? now : null
  }
}

function settlePayouts(game) {
  game = getGame(game.id)
  if (game.payout_status === 'processing') {
    return {game, payout: {ok: true, pending: true, processing: true}}
  }
  if (!['pending', 'failed'].includes(game.payout_status)) {
    return {
      game,
      payout: {
        ok: game.payout_pending !== true,
        pending: game.payout_pending === true
      }
    }
  }
  storage.set(GAMES_TABLE, {
    ...game,
    payout_status: 'processing',
    updated_at: system.now()
  })
  let current = getGame(game.id)
  const targets = current.status === 'draw'
    ? [
        {seat: 'player1', amount: Number(current.join_amount)},
        {seat: 'player2', amount: Number(current.join_amount)}
      ]
    : [{seat: current.winner_seat, amount: winnerPayoutAmount(current)}]
  const results = []
  for (const target of targets) {
    const statusField = `${target.seat}_payout_status`
    const paymentHashField = `${target.seat}_payout_payment_hash`
    const targetStatus = current[statusField]
    if (targetStatus === 'paid') continue
    const existingPaymentHash = current[paymentHashField] || ''
    const result =
      targetStatus === 'pending' && existingPaymentHash
        ? {
            ok: false,
            pending: true,
            error: 'Payout was submitted and is awaiting confirmation.',
            paymentHash: existingPaymentHash
          }
        : payPlayer(current, target.seat, target.amount)
    results.push({...result, seat: target.seat})
    current = {
      ...current,
      [statusField]: result.ok ? 'paid' : result.pending ? 'pending' : 'failed',
      [paymentHashField]: result.paymentHash || existingPaymentHash,
      updated_at: system.now()
    }
    storage.set(GAMES_TABLE, current)
  }
  const unresolved = targets.filter(
    target => current[`${target.seat}_payout_status`] !== 'paid'
  )
  const pending = unresolved.length > 0
  const waitingForPayment = unresolved.some(
    target => current[`${target.seat}_payout_status`] === 'pending'
  )
  current = {
    ...current,
    payout_pending: pending,
    payout_status: pending ? (waitingForPayment ? 'pending' : 'failed') : 'paid',
    updated_at: system.now()
  }
  storage.set(GAMES_TABLE, current)
  publishGame(current, 'settled')
  return {
    game: current,
    payout: {
      ok: !pending,
      pending,
      payments: results,
      error: results.find(result => !result.ok)?.error || ''
    }
  }
}

function payPlayer(game, seat, amount) {
  const lnAddress = game[`${seat}_ln_address`]
  if (!seat || !lnAddress) return {ok: false, error: 'Payout player is missing.'}
  if (!game.wallet_id) return {ok: false, error: 'Poker wallet is not configured.'}
  if (!Number.isInteger(amount) || amount <= 0) {
    return {ok: false, error: 'Payout amount must be greater than zero.'}
  }
  try {
    const response = wallet.payLnurl({
      walletId: game.wallet_id,
      lnurl: lnAddress,
      amount,
      maxSat: amount,
      comment: game.status === 'draw' ? 'Poker split pot' : 'Poker winnings',
      description: `Poker payout for ${game.name}`,
      extra: {poker_game_id: game.id, poker_seat: seat}
    })
    const success = response.success === true
    const pending = response.pending === true || response.status === 'pending'
    return {
      ok: success,
      pending: !success && pending,
      error: response.error || '',
      checkingId: response.checkingId || '',
      paymentHash: response.paymentHash || '',
      status: response.status || ''
    }
  } catch (error) {
    return {ok: false, error: errorMessage(error)}
  }
}

function refundPlayer(game, lnAddress, amount, reason) {
  if (!Number.isInteger(amount) || amount <= 0) {
    return {ok: false, error: 'Refund amount must be greater than zero.'}
  }
  try {
    const response = wallet.payLnurl({
      walletId: game.wallet_id,
      lnurl: lnAddress,
      amount,
      maxSat: amount,
      comment: 'Poker refund',
      description: `Poker refund for ${game.name}`,
      extra: {poker_game_id: game.id, poker_refund_reason: reason}
    })
    return {ok: response.ok === true, error: response.error || ''}
  } catch (error) {
    return {ok: false, error: errorMessage(error)}
  }
}

function retryPlayerRefund(game, player, paidSat) {
  const amount = player.status === 'amount-mismatch'
    ? paidSat
    : Number(game.join_amount)
  const reason = player.status === 'amount-mismatch'
    ? 'amount-mismatch'
    : 'seat-unavailable'
  const refund = refundPlayer(game, player.ln_address, amount, reason)
  if (refund.ok) {
    player = {...player, status: 'refunded'}
    storage.set(PLAYERS_TABLE, player)
  }
  return {player, refund}
}

function seatPaidPlayer(game, player) {
  const seat = player.seat
  if (!['player1', 'player2'].includes(seat)) {
    return refundUnseatedPlayer(game, player)
  }
  const hashField = `${seat}_payment_hash`
  const addressField = `${seat}_ln_address`
  if (game[hashField] && game[hashField] !== player.payment_hash) {
    return refundUnseatedPlayer(game, player)
  }
  if (game[hashField] === player.payment_hash) {
    return {game, player}
  }

  const now = system.now()
  const player1Hash = seat === 'player1'
    ? player.payment_hash
    : game.player1_payment_hash
  const player2Hash = seat === 'player2'
    ? player.payment_hash
    : game.player2_payment_hash
  const playersCount = Number(Boolean(player1Hash)) + Number(Boolean(player2Hash))
  const updatedGame = {
    ...game,
    [hashField]: player.payment_hash,
    [addressField]: player.ln_address,
    players_count: playersCount,
    status: playersCount === 2 ? 'active' : 'waiting',
    started_at: playersCount === 2 ? game.started_at || now : game.started_at,
    updated_at: now
  }
  if (playersCount === 2) dealHands(updatedGame)
  storage.set(GAMES_TABLE, updatedGame)
  publishGame(updatedGame, 'player-paid')
  return {game: updatedGame, player}
}

function refundUnseatedPlayer(game, player) {
  let updatedPlayer = {...player, status: 'refund-pending'}
  storage.set(PLAYERS_TABLE, updatedPlayer)
  const refund = refundPlayer(
    game,
    updatedPlayer.ln_address,
    Number(game.join_amount),
    'seat-conflict'
  )
  if (refund.ok) {
    updatedPlayer = {...updatedPlayer, status: 'refunded'}
    storage.set(PLAYERS_TABLE, updatedPlayer)
  }
  return {game, player: updatedPlayer, refund}
}

function dealHands(game) {
  const secrets = getSecrets(game.id)
  const deck = parseCards(secrets.deck_json)
  if (deck.length !== 52) throw new Error('The Poker deck is invalid.')
  const firstHand = parseCards(secrets.player1_hand_json)
  const secondHand = parseCards(secrets.player2_hand_json)
  if (
    firstHand.length === 5 &&
    secondHand.length === 5 &&
    Number(secrets.deck_position || 0) >= 10
  ) {
    return
  }
  storage.set(SECRETS_TABLE, {
    ...secrets,
    player1_hand_json: JSON.stringify(deck.slice(0, 5)),
    player2_hand_json: JSON.stringify(deck.slice(5, 10)),
    deck_position: 10,
    updated_at: system.now()
  })
}

function playerHand(game, seat) {
  const secrets = getSecrets(game.id)
  return publicHand(
    parseCards(secrets[`${seat}_hand_json`]),
    true
  )
}

function recordAction(game, seat, actionType, cardsCount, handLabel) {
  const number = Number(game.action_count || 0) + 1
  storage.set(ACTIONS_TABLE, {
    id: `${game.id}-${number}`,
    game_id: game.id,
    action_number: number,
    hand_number: handNumber(game),
    seat,
    action_type: actionType,
    cards_count: cardsCount,
    hand_label: handLabel,
    created_at: system.now()
  })
  return {...game, action_count: number}
}

function publicActions(game) {
  if (!Number(game.action_count || 0)) return []
  return storage
    .getPaginated(ACTIONS_TABLE, {
      filters: {game_id: game.id},
      sortBy: 'action_number',
      descending: false,
      limit: 100,
      offset: Math.max(0, Number(game.action_count) - 100)
    })
    .data.map(action => ({
      number: Number(action.action_number || 0),
      handNumber: Number(action.hand_number || 1),
      seat: action.seat,
      type: action.action_type,
      cardsCount: Number(action.cards_count || 0),
      handLabel: action.hand_label || '',
      createdAt: Number(action.created_at || 0)
    }))
}

function deletePlayerRecords(gameId) {
  for (let batch = 0; batch < 20; batch += 1) {
    const players = storage.getPaginated(PLAYERS_TABLE, {
      filters: {game_id: gameId},
      sortBy: 'created_at',
      descending: false,
      limit: 100,
      offset: 0
    }).data
    if (!players.length) return
    for (const player of players) storage.delete(PLAYERS_TABLE, player.id)
  }
  throw new Error('Too many Poker payment records to delete safely.')
}

function shuffledDeck(seed, seedHash = '') {
  const deck = []
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(`${rank}${suit}`)
  }
  const random = seededRandom(seed, seedHash)
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swap = random.nextInt(index + 1)
    ;[deck[index], deck[swap]] = [deck[swap], deck[index]]
  }
  return deck
}

function seededRandom(seed, seedHash) {
  const digest = seedHash || sha256(seed)
  let first = Number.parseInt(digest.slice(0, 8), 16) >>> 0
  let second = Number.parseInt(digest.slice(8, 16), 16) >>> 0
  let third = Number.parseInt(digest.slice(16, 24), 16) >>> 0
  let fourth = Number.parseInt(digest.slice(24, 32), 16) >>> 0
  if (!(first || second || third || fourth)) fourth = 1

  function nextUint32() {
    const value = (first ^ (first << 11)) >>> 0
    first = second
    second = third
    third = fourth
    fourth = (
      fourth ^
      (fourth >>> 19) ^
      value ^
      (value >>> 8)
    ) >>> 0
    return fourth
  }
  return {
    nextInt(maxExclusive) {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new Error('Random range must be a positive integer.')
      }
      const range = 4294967296
      const limit = Math.floor(range / maxExclusive) * maxExclusive
      let value
      do {
        value = nextUint32()
      } while (value >= limit)
      return value % maxExclusive
    }
  }
}

function sha256(value) {
  const bytes = []
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      )
    }
  }
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  for (let shift = 56; shift >= 0; shift -= 8) {
    bytes.push(Math.floor(bitLength / 2 ** shift) & 0xff)
  }

  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]
  const words = new Array(64)
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4
      words[index] = (
        (bytes[start] << 24) |
        (bytes[start + 1] << 16) |
        (bytes[start + 2] << 8) |
        bytes[start + 3]
      ) >>> 0
    }
    for (let index = 16; index < 64; index += 1) {
      const first = words[index - 15]
      const second = words[index - 2]
      const sigma0 = rotateRight(first, 7) ^ rotateRight(first, 18) ^ (first >>> 3)
      const sigma1 = rotateRight(second, 17) ^ rotateRight(second, 19) ^ (second >>> 10)
      words[index] = (
        words[index - 16] + sigma0 + words[index - 7] + sigma1
      ) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = hash
    for (let index = 0; index < 64; index += 1) {
      const choice = (e & f) ^ (~e & g)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const temp1 = (h + sum1 + choice + constants[index] + words[index]) >>> 0
      const temp2 = (sum0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    hash[0] = (hash[0] + a) >>> 0
    hash[1] = (hash[1] + b) >>> 0
    hash[2] = (hash[2] + c) >>> 0
    hash[3] = (hash[3] + d) >>> 0
    hash[4] = (hash[4] + e) >>> 0
    hash[5] = (hash[5] + f) >>> 0
    hash[6] = (hash[6] + g) >>> 0
    hash[7] = (hash[7] + h) >>> 0
  }
  return hash.map(word => word.toString(16).padStart(8, '0')).join('')
}

function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits))
}

function evaluateHand(cards) {
  if (!Array.isArray(cards) || cards.length !== 5) throw new Error('A five-card hand is required.')
  const values = cards.map(cardValue).sort((a, b) => b - a)
  const suits = cards.map(card => card[1])
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1)
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])
  const unique = [...new Set(values)]
  let straightHigh = 0
  if (unique.length === 5 && unique[0] - unique[4] === 4) straightHigh = unique[0]
  if (unique.join(',') === '14,5,4,3,2') straightHigh = 5
  const flush = new Set(suits).size === 1

  if (straightHigh && flush) {
    return {score: [8, straightHigh], label: `${rankSingular(straightHigh)}-high straight flush`}
  }
  if (groups[0][1] === 4) {
    return {score: [7, groups[0][0], groups[1][0]], label: `Four ${RANK_NAMES[groups[0][0]]}`}
  }
  if (groups[0][1] === 3 && groups[1][1] === 2) {
    return {score: [6, groups[0][0], groups[1][0]], label: `${RANK_NAMES[groups[0][0]]} full of ${RANK_NAMES[groups[1][0]]}`}
  }
  if (flush) return {score: [5, ...values], label: `${rankSingular(values[0])}-high flush`}
  if (straightHigh) return {score: [4, straightHigh], label: `${rankSingular(straightHigh)}-high straight`}
  if (groups[0][1] === 3) {
    const kickers = groups.filter(group => group[1] === 1).map(group => group[0]).sort((a, b) => b - a)
    return {score: [3, groups[0][0], ...kickers], label: `Three ${RANK_NAMES[groups[0][0]]}`}
  }
  const pairs = groups.filter(group => group[1] === 2).map(group => group[0]).sort((a, b) => b - a)
  if (pairs.length === 2) {
    const kicker = groups.find(group => group[1] === 1)[0]
    return {score: [2, ...pairs, kicker], label: `Two pair, ${RANK_NAMES[pairs[0]]} and ${RANK_NAMES[pairs[1]]}`}
  }
  if (pairs.length === 1) {
    const kickers = groups.filter(group => group[1] === 1).map(group => group[0]).sort((a, b) => b - a)
    return {score: [1, pairs[0], ...kickers], label: `Pair of ${RANK_NAMES[pairs[0]]}`}
  }
  return {score: [0, ...values], label: `${rankSingular(values[0])}-high`}
}

function compareScores(first, second) {
  const length = Math.max(first.length, second.length)
  for (let index = 0; index < length; index += 1) {
    if ((first[index] || 0) !== (second[index] || 0)) {
      return (first[index] || 0) - (second[index] || 0)
    }
  }
  return 0
}

function cardValue(card) {
  const rank = RANKS.indexOf(card?.[0])
  if (rank < 0 || !SUITS.includes(card?.[1])) throw new Error('Invalid card.')
  return rank + 2
}

function rankSingular(value) {
  return {
    14: 'Ace',
    13: 'King',
    12: 'Queen',
    11: 'Jack',
    10: 'Ten',
    9: 'Nine',
    8: 'Eight',
    7: 'Seven',
    6: 'Six',
    5: 'Five',
    4: 'Four',
    3: 'Three',
    2: 'Two'
  }[value]
}

function getSettings() {
  return storage.get(SETTINGS_TABLE, SETTINGS_ID, defaultSettings())
}

function defaultSettings() {
  const now = system.now()
  return {
    id: SETTINGS_ID,
    wallet_id: '',
    wallet_name: '',
    enabled: false,
    haircut: 0,
    created_at: now,
    updated_at: now
  }
}

function getGame(gameId) {
  const game = storage.get(GAMES_TABLE, gameId, null)
  if (!game) throw new Error('Poker game not found.')
  return game
}

function getSecrets(gameId) {
  const secrets = storage.get(SECRETS_TABLE, gameId, null)
  if (!secrets) throw new Error('Poker game secrets not found.')
  return secrets
}

function markPlayer(paymentHash, gameId, lnAddress, seat, status) {
  const existing = storage.get(PLAYERS_TABLE, paymentHash, null)
  const now = system.now()
  const player = {
    id: paymentHash,
    game_id: gameId,
    ln_address: existing?.ln_address || lnAddress,
    payment_hash: paymentHash,
    seat: existing?.seat || seat,
    status,
    created_at: existing?.created_at || now,
    paid_at: ['paid', 'refund-pending'].includes(status)
      ? existing?.paid_at || now
      : existing?.paid_at || null
  }
  storage.set(PLAYERS_TABLE, player)
  return player
}

function playerForToken(game, token) {
  if (!token) return null
  if (token === game.player1_payment_hash) {
    return playerFromGame(game, 'player1', token)
  }
  if (token === game.player2_payment_hash) {
    return playerFromGame(game, 'player2', token)
  }
  return null
}

function playerFromGame(game, seat, token) {
  return {
    id: token,
    game_id: game.id,
    ln_address: game[`${seat}_ln_address`],
    payment_hash: token,
    seat,
    status: 'paid',
    paid_at: 0
  }
}

function requirePlayer(game, token) {
  const player = playerForToken(game, token)
  if (!player) throw new Error('A paid player token is required.')
  return player
}

function publicSettings(settings) {
  return {
    id: settings.id,
    enabled: settings.enabled === true,
    haircut: Number(settings.haircut || 0),
    walletId: settings.wallet_id || '',
    walletName: settings.wallet_name || '',
    createdAt: Number(settings.created_at || 0),
    updatedAt: Number(settings.updated_at || 0)
  }
}

function publicGame(game, revealedSeed = '') {
  return {
    id: game.id,
    name: game.name,
    joinAmount: Number(game.join_amount || 0),
    potAmount: Number(game.join_amount || 0) * Number(game.players_count || 0),
    winnerPayout: game.players_count === 2 ? winnerPayoutAmount(game) : 0,
    haircut: Number(game.haircut || 0),
    playersCount: Number(game.players_count || 0),
    status: game.status || 'waiting',
    matchTarget: matchTarget(game),
    handNumber: handNumber(game),
    player1Score: Number(game.player1_score || 0),
    player2Score: Number(game.player2_score || 0),
    turn: game.turn || '',
    player1Drawn: game.player1_drawn === true,
    player2Drawn: game.player2_drawn === true,
    player1DiscardCount: Number(game.player1_discard_count || 0),
    player2DiscardCount: Number(game.player2_discard_count || 0),
    winnerSeat: game.winner_seat || '',
    winnerLnAddress: maskLnAddress(game.winner_ln_address || ''),
    resultLabel: game.result_label || '',
    payoutPending: game.payout_pending === true,
    payoutStatus: game.payout_status || '',
    deckCommitment: game.deck_commitment || '',
    revealedSeed,
    actionCount: Number(game.action_count || 0),
    createdAt: Number(game.created_at || 0),
    updatedAt: Number(game.updated_at || 0),
    startedAt: Number(game.started_at || 0),
    completedAt: Number(game.completed_at || 0)
  }
}

function publicPlayers(game) {
  const players = []
  for (const seat of ['player1', 'player2']) {
    const address = game[`${seat}_ln_address`]
    if (!address) continue
    players.push({
      seat,
      label: seatLabel(seat),
      lnAddress: maskLnAddress(address),
      status: 'paid',
      drawn: game[`${seat}_drawn`] === true,
      discardCount: Number(game[`${seat}_discard_count`] || 0)
    })
  }
  return players
}

function publicPlayer(player, includeToken) {
  return {
    id: includeToken ? player.id : '',
    gameId: player.game_id,
    lnAddress: maskLnAddress(player.ln_address),
    seat: player.seat,
    label: seatLabel(player.seat),
    status: player.status
  }
}

function publicHand(cards, revealed) {
  return cards.map(card => ({code: revealed ? card : '', hidden: !revealed}))
}

function hiddenHand(count) {
  return Array.from({length: count}, () => ({code: '', hidden: true}))
}

function winnerPayoutAmount(game) {
  const total = Number(game.join_amount || 0) * 2
  if (total <= 0) return 0
  return Math.max(1, Math.trunc(total - total * (Number(game.haircut || 0) / 100)))
}

function publishGame(game, event) {
  try {
    websocket.publish(`game:${game.id}`, {
      type: 'server',
      event,
      game: publicGame(game)
    })
  } catch (error) {
    system.log(`poker websocket publish failed: ${errorMessage(error)}`, 'warning')
  }
}

function runJson(fn) {
  try {
    return JSON.stringify({ok: true, data: fn()})
  } catch (error) {
    return JSON.stringify({ok: false, error: errorMessage(error)})
  }
}

function parseJsonObject(value) {
  if (!value) return {}
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request must be a JSON object.')
  }
  return parsed
}

function parseCards(value) {
  const cards = typeof value === 'string' ? JSON.parse(value || '[]') : value
  if (!Array.isArray(cards)) throw new Error('Invalid card data.')
  return cards
}

function normalizeDiscardIndices(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('discardIndices must be an array.')
  if (value.some(index => typeof index !== 'number' || !Number.isInteger(index))) {
    throw new Error('Discard indices must be integers from 0 to 4.')
  }
  const indices = [...value]
  if (indices.some(index => index < 0 || index > 4)) {
    throw new Error('Discard indices must be integers from 0 to 4.')
  }
  if (new Set(indices).size !== indices.length) {
    throw new Error('Discard indices must be unique.')
  }
  if (indices.length > MAX_DISCARDS) {
    throw new Error(`You can discard at most ${MAX_DISCARDS} cards.`)
  }
  return [...indices].sort((a, b) => a - b)
}

function normalizeInteger(value, fallback, min, max) {
  const number = Number(value ?? fallback)
  if (!Number.isInteger(number)) throw new Error('value must be an integer.')
  if (number < min) throw new Error(`value must be at least ${min}.`)
  if (number > max) throw new Error(`value must be at most ${max}.`)
  return number
}

function normalizePercent(value, fallback) {
  const number = Number(value ?? fallback)
  if (!Number.isFinite(number) || number < 0 || number >= 100) {
    throw new Error('haircut must be at least 0 and less than 100.')
  }
  return number
}

function normalizeMatchTarget(value) {
  if (value === undefined || value === null || value === '') return 3
  const target = Number(value)
  if (![1, 3].includes(target)) {
    throw new Error('matchTarget must be 1 or 3.')
  }
  return target
}

function matchTarget(game) {
  const target = Number(game.match_target || 1)
  return target === 3 ? 3 : 1
}

function handNumber(game) {
  const number = Number(game.hand_number || 1)
  return Number.isInteger(number) && number > 0 ? number : 1
}

function startingSeat(gameOrHandNumber) {
  const number =
    typeof gameOrHandNumber === 'number'
      ? gameOrHandNumber
      : handNumber(gameOrHandNumber)
  return number % 2 === 0 ? 'player2' : 'player1'
}

function oppositeSeat(seat) {
  return seat === 'player1' ? 'player2' : 'player1'
}

function normalizePageSize(value) {
  const size = Number(value || 10)
  return Number.isInteger(size) && size > 0 ? Math.min(size, 100) : 10
}

function normalizePage(value) {
  const page = Number(value || 1)
  return Number.isInteger(page) && page > 0 ? page : 1
}

function normalizeGameSortBy(value) {
  return {
    name: 'name',
    joinAmount: 'join_amount',
    playersCount: 'players_count',
    status: 'status',
    createdAt: 'created_at'
  }[value] || 'created_at'
}

function normalizeLnAddress(value) {
  const address = cleanText(value, 180).toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    throw new Error('A valid Lightning address is required.')
  }
  return address
}

function eventPaymentHash(event) {
  return (
    cleanText(event.paymentHash, 128) ||
    cleanText(event.payment_hash, 128) ||
    cleanText(event.extra?.paymentHash, 128) ||
    cleanText(event.payment?.payment_hash, 128) ||
    cleanText(event.payment?.paymentHash, 128)
  )
}

function cleanId(value) {
  return typeof value === 'string'
    ? value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
    : ''
}

function cleanText(value, maxLength) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, maxLength)
    : ''
}

function requiredText(value, field, maxLength) {
  const text = cleanText(value, maxLength)
  if (!text) throw new Error(`${field} is required.`)
  return text
}

function maskLnAddress(address) {
  const [name, domain] = cleanText(address, 180).split('@')
  if (!name || !domain) return address
  return `${name.slice(0, 3)}${name.length > 3 ? '…' : ''}@${domain}`
}

function seatLabel(seat) {
  if (seat === 'player1') return 'Player 1'
  if (seat === 'player2') return 'Player 2'
  return 'Dealer'
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
