/**
 * A docker stub for the HAP-1748 offline Neo4j dump/load. Every call lands in "$OUT.calls" ("docker <args>"). The live
 * container cmdb-neo4j is listed by `ps` as running unless NEO4J_DOWN is set, `inspect` names its image, and each
 * one-off neo4j-admin container records its command at `create`; its `start -a` fails for FAIL_DUMP (dump), FAIL_LOAD
 * (load) or FAIL_INFO (load --info). FAIL_START fails starting cmdb-neo4j. `cp <container>:<path> <file>` writes a
 * dump. cypher-shell answers the node and relationship counts with NODES (default 5) and RELS (default 7).
 */
export const NEO4J_DOCKER_STUB = [
  'echo "docker $*" >> "$OUT.calls"',
  'case "$1" in',
  '  ps) [ -n "$NEO4J_DOWN" ] || echo cmdb-neo4j;;',
  '  inspect) echo neo4j:5.15-community;;',
  '  create) echo "$*" > "$OUT.cmd.$3";;',
  '  start) if [ "$2" = -a ]; then case "$(cat "$OUT.cmd.$3")" in',
  '      *"load --info"*) [ -z "$FAIL_INFO" ] || exit 1;;',
  '      *" load "*) [ -z "$FAIL_LOAD" ] || exit 1;;',
  '      *" dump "*) [ -z "$FAIL_DUMP" ] || exit 1;;',
  '    esac; else [ -z "$FAIL_START" ] || exit 1; fi;;',
  '  cp) case "$2" in *:*) echo dump > "$3";; esac;;',
  '  exec) case "$*" in',
  '      *"count(n)"*) echo count; echo "${NODES:-5}";;',
  '      *"count(r)"*) echo count; echo "${RELS:-7}";;',
  '    esac;;',
  'esac',
  'exit 0',
];
