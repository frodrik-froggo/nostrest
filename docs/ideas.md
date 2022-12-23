# Find good connection

## As entry of bridge: ##
0) Get list of realays.
1) Select n random relays.
2) Send "HENLO" to pubkey of mint. (Ephemeral or request deletion)
3) If you receive "ITSME" from pubkey of mint on a relay, it will contain a list of relays. Replace the initial list with this list (Ephemeral or request deletion)
4) If you don't receive a ITSME, go to 1) chosing different set of relays.
5) If you loose connection to a relay, remove it from list of relays and go to step 2

always: only do things if list of relays is big enough (4-8)

## As exit of bridge: ##
send IMOVED(oldrelay,newrelay) to tell the entry of the bridge that it closed the connection to one relay and opened it to another relay. (Ephemeral or request deletion)

Assumption: If we have enough relays connected which are also connected to a mint, the requests will
most likely arrive at the other side and the response will be seen by us. (see Two Generals Problem)

# Basic Protocol
## Data Level
All calls are wrapped JSON-RPC bodies wrapped in a DM (kind 4)
### JSON-RPC body

## Communication
1) Entry: wait for "stable connection" (See "Find good connection")
2) Entry: Send request
3) Entry: Wait for at least one "OK" (now we know at least one relay has the event)
4) Exit: Process request and send Response data
5) Exit: Wait for at least one "OK" (now we know at least one relay has the event)
6) Entry: Wait for Response data

# Notes:

* Store all sends and receives on every side for recovery until a request has been completely processed
and every side knows that for sure.

# Ideas
* make it bidirectional?
* abstract rest away from base layer. only make base layer a reliable request/response layer
* build libraries for encoding request/response (nodejs, browser, rust, wasm)
* NIP26 https://github.com/nostr-protocol/nips/blob/master/26.md !
