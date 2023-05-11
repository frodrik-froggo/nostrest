# Nostrest

## Usage

### Installing

#### OSX (homebrew)

``` shell
# install nvm (node version manager) - skip this when u already have nvm installed
brew install nvm
# install node 20 - skip this when u already have node 20 installed
nvm install 20
# use node 20
nvm use 20
```

#### Linux

install nvm (node version manager) - skip this when u already have nvm installed. See https://github.com/nvm-sh/nvm

``` shell
# install node 20 - skip this when u already have node 20 installed
nvm install 20
# use node 20
nvm use 20
```

#### All

``` shell
git clone git@github.com:schulterklopfer/nostrest.git
cd nostrest
node --version # should be major version 20, if not: you forgot to nvm use 20

# install module dependencies
nvm ci
```

### Running nostrest

#### config.json
Edit `config.json` to reflect your setup, but the initial content should be ok for testing out nostrest, except the `mintNostrPubkey` entry in the `restnostr` section.

| root entry | description                                                                                                                                                                    |
|------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| nostrest   | config for **exit of the bridge** which calls the REST service                                                                                                                 |
| restnostr  | config for **entry of the bridge** which will provide a transparent REST api and encode calls into a pseudo json-rpc call over nostr which then is decoded by the nostrest end |


You can put a nostr private key into `key_nostrest.txt`. If that file is not present, it will be generated randomly.

``` shell
# start the exit of the bridge, which will call the REST service
npm run nostrest
```

Look for `My public key is: <string>`. `<string>` will be your public key. See below where to put that.

Change the `mintNostrPubkey` entry in the `restnostr` section of `config.json` to the above pubkey.

### Running restnostr

You can put a nostr private key into `key_restnostr.txt`. If that file is not present, it will be generated randomly.

``` shell
# start the entry of the bridge, which provides a local REST service
npm run restnostr
```

### Running minirest (dumbest REST ever for testing things)

Make sure nothing is bound to port 3338 on localhost.

``` shell
# start the entry of the bridge, which provides a local REST service
npm run minirest
# confirm minirest is running:
curl localhost:3338/whodis
# -> It'se Mario!
```

### Trying it out

``` shell
# confirm the bridge is relaying REST calls from localhost:3888 
# (the bridge entry) to localhost:3338 (minirest) and is giving 
# you the correct result.
curl localhost:3888/whodis
# -> It'se Mario!
```

You can replace `minirest` with any other REST service. Edit `config.json` accordingly.
No HTTP headers are supported right now. This means you cannot add an authentication header to your call. Should be not hard to add, though.

## Basic concepts

### Find good connection

#### As entry of bridge: ##
0) Get list of relays (Source is unspecified. Might be a file, might be from the web)
1) Select n random relays, which SHOULD include the default relay for faster discovery
2) Send "HENLO" to pubkey of the exit
3) If you receive "ITSME" from pubkey of exit on a relay, it will contain a list of relays. Replace the initial list with this list.
4) If you don't receive a ITSME within a certain amount of time, go to 1) choosing different set of relays.

* if you receive an IMOVED from the exit: Close the connection to the old relay and open a connection to the new relay in the message.
* always: Check if relay supports ephemeral events before connecting to it.
* always: Only do things if list of relays is big enough (4-8)
* always: Keep an eye on how many relays transmitted an event. If this number gets too low, something is wrong.

#### As exit of bridge: ##
* from time to time: Send IMOVED(oldrelay, newrelay) to tell the entry of the bridge that it closed the connection to one relay and opened it to another relay.
* always: Check if relay supports ephemeral events before connecting to it.
* always: Check if there are enough connected relays
* always: Store all received events and results on exit side for recovery until a request has been completely processed.
### Basic Protocol

Assumption: If the entry has enough relays connected which are also connected to the exit, the requests will most likely arrive at the other side and the response will be seen by the entry. (see Two Generals Problem)

#### Data Level
All calls are wrapped JSON-RPC bodies wrapped in an ephemeral event (kind 20004)
##### JSON-RPC request
TODO
##### JSON-RPC result
TODO

#### Communication
1) Entry: wait for "good connection" (Once)
2) Entry: Send request
3) Exit: Process request and send Response data
4) Entry: Wait for Response data
5) Entry: Send GOTIT

![mint](https://github.com/schulterklopfer/nostrest/blob/master/docs/control_flow.png?raw=true)


### Ideas
* make it bidirectional?
* build libraries for encoding request/response (nodejs, browser, rust, wasm)
* NIP26 https://github.com/nostr-protocol/nips/blob/master/26.md


