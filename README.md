# Nostrest

## Find good connection

### As entry of bridge: ##
0) Get list of relays (Source is unspecified. Might be a file, might be from the web)
1) Select n random relays, which SHOULD include the default relay for faster discovery
2) Send "HENLO" to pubkey of the exit
3) If you receive "ITSME" from pubkey of exit on a relay, it will contain a list of relays. Replace the initial list with this list.
4) If you don't receive a ITSME within a certain amount of time, go to 1) choosing different set of relays.

* if you receive an IMOVED from the exit: Close the connection to the old relay and open a connection to the new relay in the message.
* always: Check if relay supports ephemeral events before connecting to it.
* always: Only do things if list of relays is big enough (4-8)
* always: Keep an eye on how many relays transmitted an event. If this number gets too low, something is wrong.

### As exit of bridge: ##
* from time to time: Send IMOVED(oldrelay, newrelay) to tell the entry of the bridge that it closed the connection to one relay and opened it to another relay.
* always: Check if relay supports ephemeral events before connecting to it.
* always: Check if there are enough connected relays
* always: Store all received events and results on exit side for recovery until a request has been completely processed.
## Basic Protocol

Assumption: If the entry has enough relays connected which are also connected to the exit, the requests will most likely arrive at the other side and the response will be seen by the entry. (see Two Generals Problem)

### Data Level
All calls are wrapped JSON-RPC bodies wrapped in an ephemeral event (kind 20004)
#### JSON-RPC request
TODO
#### JSON-RPC result
TODO

### Communication
1) Entry: wait for "good connection" (Once)
2) Entry: Send request
3) Exit: Process request and send Response data
4) Entry: Wait for Response data
5) Entry: Send GOTIT

![mint](https://github.com/schulterklopfer/nostrest/blob/master/docs/control_flow.png?raw=true)


## Ideas
* make it bidirectional?
* build libraries for encoding request/response (nodejs, browser, rust, wasm)
* NIP26 https://github.com/nostr-protocol/nips/blob/master/26.md


