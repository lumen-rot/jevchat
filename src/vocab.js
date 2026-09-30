// Jev chat vocabulary. 253 tokens, word-level. <eot> ends the assistant's turn.
export const EOT = '<eot>';

export const VOCAB = `
i me my we our you your it its they them he she us
am is are was were be been being do does did can could will would should may might must
have has had get got go going know think feel want need like love hate make made
say said tell told talk see look hear help work run play learn build use remember
jev model ai llm language word words line lines poem poetry verse song story voice
moon sun star stars night sky light lights dark darkness shadow silver gold pale bright
dream dreams sleep wake heart soul mind memory time day days year years
wind rain snow storm sea ocean river water fire flame earth stone mountain tree trees
flower garden bird birds fly wing wings dance sing music echo whisper silence
quiet soft gentle warm cold deep high low far near home away
hold keep let fall fell rise rose walk wait
world life death peace truth lie
and or but so because if when what why how who where while until through across
beyond beneath above around into out up down over under again still once before after
never always forever only just even too very really quite almost perhaps maybe
the a an this that these those some all none every each other another
true false good bad great small big old new same different beautiful
lonely lost found free dim
not no yes oh ah
, . ! ? ; : ' -
${EOT}
`
  .split(/\s+/)
  .filter(Boolean);
