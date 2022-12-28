#!/usr/bin/env sh

#plantuml -v -tsvg -o .. overview_mint.puml
#plantuml -v -tsvg -o .. overview_mint_ideal.puml
#plantuml -v -tsvg -o .. overview_p2p_ideal.puml

plantuml -v -tpng -o . control_flow.puml
plantuml -v -tpng -o . cashu/overview_mint.puml
plantuml -v -tpng -o . cashu/overview_mint_ideal.puml
plantuml -v -tpng -o . cashu/overview_p2p_ideal.puml
