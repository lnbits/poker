;(function () {
  let portPromise = null
  const handlers = new Map()

  function createLNbitsExtensionClient({extensionId}) {
    const base = `/api/v1/ext/${extensionId}`
    return {
      context: () => bridge({action: 'context'}),
      notify: (message, level = 'info') =>
        bridge({action: 'ui.notify', message: String(message), level}),
      requestBackgroundPaymentPermission: (grant, options = {}) =>
        bridge({
          action: 'permissions.request_background_payment',
          grant,
          forcePrompt: options.forcePrompt === true
        }),
      getSettings: () => request(`${base}/settings`),
      saveSettings: payload => request(`${base}/settings`, 'PUT', payload),
      listWallets: () => request(`${base}/wallets`),
      createGame: payload => request(`${base}/games`, 'POST', payload),
      listGames: (params = {}) => {
        const query = new URLSearchParams()
        Object.entries(params).forEach(([key, value]) => {
          if (value !== '' && value !== null && value !== undefined) {
            query.set(key, String(value))
          }
        })
        return request(`${base}/games${query.size ? `?${query}` : ''}`)
      },
      deleteGame: id => request(`${base}/games/${encodeURIComponent(id)}`, 'DELETE'),
      getPublicGame: (id, playerToken = '') => {
        const query = playerToken ? `?${new URLSearchParams({playerToken})}` : ''
        return request(`${base}/games/${encodeURIComponent(id)}${query}`)
      },
      joinGame: (id, payload) =>
        request(`${base}/games/${encodeURIComponent(id)}/join`, 'POST', payload),
      drawCards: (id, payload) =>
        request(`${base}/games/${encodeURIComponent(id)}/draw`, 'POST', payload),
      fold: (id, payload) =>
        request(`${base}/games/${encodeURIComponent(id)}/fold`, 'POST', payload),
      startNextHand: (id, payload) =>
        request(
          `${base}/games/${encodeURIComponent(id)}/next-hand`,
          'POST',
          payload
        ),
      settlePlayerPayout: (id, payload) =>
        request(`${base}/games/${encodeURIComponent(id)}/payout`, 'POST', payload),
      settleGame: id =>
        request(`${base}/games/${encodeURIComponent(id)}/settle`, 'POST', {}),
      subscribePayment,
      subscribeWebsocket
    }
  }

  function request(path, method = 'GET', body = null) {
    return bridge({
      action: 'api',
      path,
      method,
      body: body === null ? null : JSON.parse(JSON.stringify(body))
    }).then(unwrap)
  }

  function bridge(message) {
    if (window.parent === window) {
      return Promise.reject(new Error('LNbits extension bridge is not available.'))
    }
    if (!portPromise) portPromise = connect()
    return portPromise.then(port => send(port, message))
  }

  function connect() {
    const id = requestId()
    const channel = new MessageChannel()
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('LNbits bridge timed out.')), 30000)
      const onMessage = event => {
        if (event.currentTarget !== channel.port1) return
        if (event.data?.type !== 'lnbits-extension:connected' || event.data.id !== id) return
        window.clearTimeout(timer)
        channel.port1.removeEventListener('message', onMessage)
        channel.port1.addEventListener('message', dispatchEvent)
        resolve(channel.port1)
      }
      channel.port1.addEventListener('message', onMessage)
      channel.port1.start()
      window.parent.postMessage(
        {type: 'lnbits-extension:connect', id},
        new URL(window.location.href).origin,
        [channel.port2]
      )
    })
  }

  function send(port, message) {
    const id = requestId()
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        port.removeEventListener('message', onMessage)
        reject(new Error('LNbits extension request timed out.'))
      }, 30000)
      const onMessage = event => {
        const response = event.data
        if (
          event.currentTarget !== port ||
          response?.type !== 'lnbits-extension:response' ||
          response.id !== id
        ) return
        window.clearTimeout(timer)
        port.removeEventListener('message', onMessage)
        if (response.ok === false) reject(new Error(response.error || 'Extension call failed.'))
        else resolve(response.data)
      }
      port.addEventListener('message', onMessage)
      port.postMessage({type: 'lnbits-extension:request', id, ...message})
    })
  }

  function dispatchEvent(event) {
    const message = event.data
    if (message?.type !== 'lnbits-extension:event') return
    handlers.get(message.subscriptionId)?.(message)
  }

  function subscribePayment(paymentHash, callback) {
    const subscriptionId = requestId()
    handlers.set(subscriptionId, callback)
    return bridge({action: 'payment.subscribe', paymentHash, subscriptionId})
      .then(() => () => {
        handlers.delete(subscriptionId)
        bridge({action: 'payment.unsubscribe', subscriptionId}).catch(() => {})
      })
      .catch(error => {
        handlers.delete(subscriptionId)
        throw error
      })
  }

  function subscribeWebsocket(itemId, callback) {
    const subscriptionId = requestId()
    handlers.set(subscriptionId, callback)
    return bridge({action: 'websocket.subscribe', itemId, subscriptionId})
      .then(() => ({
        active: true,
        unsubscribe() {
          this.active = false
          handlers.delete(subscriptionId)
          bridge({action: 'websocket.unsubscribe', subscriptionId}).catch(() => {})
        }
      }))
      .catch(error => {
        handlers.delete(subscriptionId)
        throw error
      })
  }

  function unwrap(value) {
    const response = typeof value === 'string' ? JSON.parse(value) : value
    if (response?.ok === false) throw new Error(response.error || 'Extension call failed.')
    return response?.ok === true ? response.data || {} : response || {}
  }

  function requestId() {
    return window.crypto?.randomUUID?.() || `poker_${Date.now()}_${Math.random()}`
  }

  window.createLNbitsExtensionClient = createLNbitsExtensionClient
})()
