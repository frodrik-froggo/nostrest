# Discovery
0) Get list of realays.
1) Select x random relays.
2) Send "HENLO" to pubkey of mint.
3) If you receive "ITSME" from pubkey of mint on a relay, add it to list of relays till it has x entries.
4) If you do not have x entries in relay list, go to 2 and select missing number of relays.
5) If you loose connection to a relay, remove it from list of relays and go to step 4

always: only do things if list of relays has equal or more than x entries

Assumption: If we have enough relays connected which are also connected to a mint, the requests will
most likely arrive at the other side and the response will be seen by us.

# Basic Protocol
## Data Level
All calls are wrapped JSON-RPC bodies wrapped in a DM (kind 4)
### JSON-RPC body



# Ideas
* Ephemeral events for Discovery
* Store all sends and receives on every side for recovery until a request has been completely processed
  and every side knows that for sure.
* make it bidirectional?
* only execute rest if other side is there to receive result
* only send request if other side is there to receive request
* abstract rest away from base layer. only make base layer a reliable request/response layer
* build libraries for encoding request/response (nodejs, browser, rust, wasm)