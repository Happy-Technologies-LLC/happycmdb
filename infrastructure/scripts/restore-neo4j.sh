#!/bin/bash
#
# Neo4j Restore Script for HappyCMDB
#
# HAP-1748: restores a backup-neo4j.sh backup (a gzip of a neo4j-admin dump of the neo4j database) over the Neo4j
# Community DBMS. Community has one standard database, neo4j, and it always exists, so a restore always replaces it:
# that is an argv opt-in (--replace-live with --pre-restore-backup FILE); no environment variable enables it. Before
# anything is stopped the backup is verified (gzip intact, `neo4j-admin database load --info` reads it). Then the
# container is stopped, the current database is dumped to the pre-restore backup and verified, the backup is loaded with
# --overwrite-destination, the container is started and the node/relationship counts are compared.
#
# Exit codes:
#   0  Replaced; Neo4j is online; the counts match the ones recorded with the backup (or none were recorded).
#   1  Nothing changed. Neo4j was started again if this script stopped it (if that failed, the output says STOPPED).
#   3  The load failed after it began: Neo4j is left STOPPED and its store may be partial. Run the printed command.
#   4  Loaded, but Neo4j did not come online or the counts differ from the backup's. Run the printed command or
#      investigate.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Configuration from environment variables or defaults
BACKUP_DIR="${BACKUP_DIR:-/var/backups/happycmdb/neo4j}"
NEO4J_CONTAINER="${NEO4J_CONTAINER:-cmdb-neo4j}"
NEO4J_USERNAME="${NEO4J_USERNAME:-neo4j}"
NEO4J_PASSWORD="${NEO4J_PASSWORD:-}"

REPLACE_LIVE=false
REPLACE_STOPPED=false
PRE_RESTORE_BACKUP=""
CHECK_ONLY=false
PREFLIGHT_ONLY=false
PREFLIGHT_MARKER="HAP-1748 PREFLIGHT OK"

# Logging functions
log_info() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] INFO: $*"
}

log_error() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2
}

log_success() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] SUCCESS: $*"
}

log_warning() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $*"
}

# shellcheck source=neo4j-offline.sh
source "${SCRIPT_DIR}/neo4j-offline.sh"

# Display usage
usage() {
    cat <<EOF
Usage: $0 --file FILE (--check | --replace-live --pre-restore-backup FILE2 [--preflight] | --replace-stopped)

Restore the Neo4j database 'neo4j' from a backup-neo4j.sh backup (*.dump.gz).

OPTIONS:
    -f, --file FILE             Backup file to restore (required)
    -c, --container NAME        Neo4j container name (default: ${NEO4J_CONTAINER})
    --check                     Verify the backup (gzip, neo4j-admin load --info) and change nothing
    --replace-live              Replace the running database: stop Neo4j, dump the current database to
                                --pre-restore-backup and verify it, load the backup, start Neo4j, compare counts
    --pre-restore-backup FILE2  Where --replace-live writes the current database; must not exist yet
    --preflight                 With --replace-live: run every check, print "${PREFLIGHT_MARKER}", change nothing
    --replace-stopped           Load the backup into a STOPPED container (after an exit 3) without a pre-restore
                                backup, then start Neo4j and compare counts
    --list                      List backups under ${BACKUP_DIR}
    --help                      Display this help message

EXIT CODES: 0 replaced and verified; 1 nothing changed; 3 load failed, Neo4j left STOPPED (store may be partial);
            4 loaded but not online or counts differ.
EOF
}

# List available backups
list_backups() {
    log_info "Available backups:"
    local kind
    for kind in daily weekly monthly; do
        echo ""
        echo "=== ${kind} ==="
        ls -lh "${BACKUP_DIR}/${kind}"/*.dump.gz 2>/dev/null | awk '{print $9, "("$5")", $6, $7, $8}' || echo "No ${kind} backups found"
    done
    exit 0
}

# Request confirmation (interactive runs only)
confirm_restore() {
    local backup_file="$1"

    echo ""
    log_warning "=== RESTORE CONFIRMATION ==="
    log_warning "Backup file: ${backup_file}"
    log_warning "Container: ${NEO4J_CONTAINER} (it is stopped for the load)"
    log_warning "The live '${NEO4J_DUMP_DATABASE}' database will be OVERWRITTEN"
    echo ""
    read -r -p "Are you sure you want to proceed? (yes/no): " confirmation

    if [[ "${confirmation}" != "yes" ]]; then
        log_info "Restore cancelled by user - nothing changed"
        exit 1
    fi
}

# The command that loads the pre-restore backup back.
return_command() {
    if [[ "$1" == stopped ]]; then
        echo "NEO4J_CONTAINER=${NEO4J_CONTAINER} bash $0 --replace-stopped --file ${PRE_RESTORE_BACKUP} < /dev/null"
    else
        echo "NEO4J_CONTAINER=${NEO4J_CONTAINER} bash $0 --replace-live --file ${PRE_RESTORE_BACKUP} --pre-restore-backup ${PRE_RESTORE_BACKUP%.dump.gz}-return-$(date +%Y%m%d-%H%M%S).dump.gz < /dev/null"
    fi
}

# Starts Neo4j after the load and compares its counts with the ones recorded next to the backup.
start_and_verify() {
    local backup_file="$1" counts_file expected actual
    if ! neo4j_start; then
        log_error "Loaded from ${backup_file}, but Neo4j is not online"
        [[ -z "${PRE_RESTORE_BACKUP}" ]] || log_error "To put the previous database back (NEO4J_PASSWORD exported): $(return_command live)"
        exit 4
    fi
    if ! actual="$(neo4j_counts)"; then
        log_error "Loaded from ${backup_file}, but the node/relationship counts could not be read"
        exit 4
    fi
    counts_file="$(neo4j_counts_file "${backup_file}")"
    if [[ -f "${counts_file}" ]]; then
        expected="$(cat "${counts_file}")"
        if [[ "${actual}" != "${expected}" ]]; then
            log_error "Loaded, but the counts (nodes relationships) are '${actual}', the backup recorded '${expected}'"
            [[ -z "${PRE_RESTORE_BACKUP}" ]] || log_error "To put the previous database back (NEO4J_PASSWORD exported): $(return_command live)"
            exit 4
        fi
        log_success "Counts match the backup: ${actual} (nodes relationships)"
    else
        log_warning "No counts were recorded with the backup: restored ${actual} (nodes relationships), not compared"
    fi
}

# Main execution
main() {
    local backup_file=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            -f|--file)
                backup_file="${2:-}"
                shift 2
                ;;
            -c|--container)
                NEO4J_CONTAINER="${2:-}"
                shift 2
                ;;
            --check)
                CHECK_ONLY=true
                shift
                ;;
            --replace-live)
                REPLACE_LIVE=true
                shift
                ;;
            --pre-restore-backup)
                PRE_RESTORE_BACKUP="${2:-}"
                shift 2
                ;;
            --preflight)
                PREFLIGHT_ONLY=true
                shift
                ;;
            --replace-stopped)
                REPLACE_STOPPED=true
                shift
                ;;
            --list)
                list_backups
                ;;
            --help)
                usage
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                usage >&2
                exit 1
                ;;
        esac
    done

    if [[ -z "${backup_file}" ]]; then
        log_error "Backup file not specified. Use --file option or --list to see available backups."
        exit 1
    fi

    log_info "===== HappyCMDB Neo4j Restore ====="

    if [[ "${CHECK_ONLY}" == true ]]; then
        neo4j_resolve_image || exit 1
        neo4j_verify_dump "${backup_file}" || exit 1
        exit 0
    fi

    # HAP-1647: cypher-shell reads it from the environment (docker exec -e NEO4J_PASSWORD), never argv.
    : "${NEO4J_PASSWORD:?must be set}"
    export NEO4J_PASSWORD

    if [[ "${REPLACE_LIVE}" == "${REPLACE_STOPPED}" ]]; then
        log_error "Community Edition has one database, '${NEO4J_DUMP_DATABASE}', and it always exists: a restore replaces it." \
            "Pass --replace-live --pre-restore-backup FILE (or --replace-stopped after an exit 3). Nothing changed."
        exit 1
    fi
    if [[ "${REPLACE_LIVE}" == true ]]; then
        if [[ -z "${PRE_RESTORE_BACKUP}" ]]; then
            log_error "--replace-live requires --pre-restore-backup FILE. Nothing changed."
            exit 1
        fi
        if [[ -e "${PRE_RESTORE_BACKUP}" || "$(realpath -m "${PRE_RESTORE_BACKUP}")" == "$(realpath -m "${backup_file}")" ]]; then
            log_error "--pre-restore-backup ${PRE_RESTORE_BACKUP} already exists (or is the --file): it must be a new file. Nothing changed."
            exit 1
        fi
        if [[ ! -d "$(dirname "${PRE_RESTORE_BACKUP}")" || ! -w "$(dirname "${PRE_RESTORE_BACKUP}")" ]]; then
            log_error "The directory of --pre-restore-backup ${PRE_RESTORE_BACKUP} is not writable. Nothing changed."
            exit 1
        fi
        if ! neo4j_container_running; then
            log_error "Neo4j container '${NEO4J_CONTAINER}' is not running (after an exit 3 use --replace-stopped). Nothing changed."
            exit 1
        fi
    elif neo4j_container_running; then
        log_error "--replace-stopped loads only into a stopped container; '${NEO4J_CONTAINER}' is running. Nothing changed."
        exit 1
    fi

    neo4j_resolve_image || exit 1
    neo4j_verify_dump "${backup_file}" || exit 1

    if [[ "${PREFLIGHT_ONLY}" == true ]]; then
        echo "${PREFLIGHT_MARKER}"
        exit 0
    fi

    if [[ -t 0 ]]; then
        confirm_restore "${backup_file}"
    fi

    if [[ "${REPLACE_LIVE}" == true ]]; then
        local before
        before="$(neo4j_counts)" || before="unreadable"
        log_info "Current database counts (nodes relationships): ${before}"
        neo4j_stop || exit 1
        if ! neo4j_dump_to "${PRE_RESTORE_BACKUP}" || ! neo4j_verify_dump "${PRE_RESTORE_BACKUP}"; then
            rm -f "${PRE_RESTORE_BACKUP}"
            log_error "The pre-restore backup of the current database failed. Nothing changed."
            exit 1
        fi
    fi

    # From here a failure may leave a partially overwritten store: never start it automatically.
    NEO4J_KEEP_STOPPED=true
    log_info "Loading ${backup_file} over the '${NEO4J_DUMP_DATABASE}' database..."
    if ! neo4j_load_from "${backup_file}"; then
        log_error "The load failed: Neo4j container '${NEO4J_CONTAINER}' is left STOPPED and its store may be partially overwritten."
        if [[ -n "${PRE_RESTORE_BACKUP}" ]]; then
            log_error "To put the previous database back (NEO4J_PASSWORD exported): $(return_command stopped)"
        else
            log_error "Load a verified backup with --replace-stopped before starting it."
        fi
        exit 3
    fi
    NEO4J_KEEP_STOPPED=false
    NEO4J_STOPPED_BY_US=true

    start_and_verify "${backup_file}"
    log_success "Restore completed: '${NEO4J_DUMP_DATABASE}' replaced from ${backup_file}"
}

# Run main function
main "$@"
