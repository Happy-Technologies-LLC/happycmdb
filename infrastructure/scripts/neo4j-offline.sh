#!/bin/bash
#
# HAP-1748: offline dump and load of the Neo4j Community DBMS, sourced by backup-neo4j.sh and restore-neo4j.sh.
# Community Edition dumps and loads a database only while the whole DBMS is stopped, and it has exactly one standard
# database, neo4j, which every HappyCMDB session uses. So the live container is stopped, neo4j-admin runs in a one-off
# container from the same image with the live container's volumes, and the live container is started again.
# The caller defines log_info/log_error/log_success and sets NEO4J_CONTAINER, NEO4J_USERNAME and NEO4J_PASSWORD.
#
# Sourcing installs an EXIT trap: if this process stopped the live container, it removes any one-off neo4j-admin
# container first (two processes must never open the store) and then starts the live container again, unless the
# caller set NEO4J_KEEP_STOPPED=true because the store may be partially overwritten. When that restart fails it says
# the container is STOPPED and prints the docker start command. When the store may be partial (an error, INT, TERM or
# HUP during the load) it leaves the container STOPPED, says so, runs the caller's NEO4J_STOPPED_HOOK (which prints the
# command that loads a good dump) and exits 3. A caller that exits 4 itself has already said what to do.

NEO4J_DUMP_DATABASE=neo4j
NEO4J_IMAGE=""
NEO4J_STOPPED_BY_US=false
NEO4J_KEEP_STOPPED=false
NEO4J_STOPPED_HOOK=""
NEO4J_ADMIN_CONTAINER=""
NEO4J_ADMIN_PID=""
NEO4J_WORK_DIR=""

# The counts file recorded next to a backup: neo4j-backup.dump.gz -> neo4j-backup.counts ("<nodes> <relationships>").
neo4j_counts_file() {
    echo "${1%.dump.gz}.counts"
}

neo4j_container_running() {
    docker ps --filter "name=^${NEO4J_CONTAINER}\$" --filter "status=running" --format '{{.Names}}' | grep -qx "${NEO4J_CONTAINER}"
}

# The one-off neo4j-admin containers run the live container's image, so the dump format always matches the DBMS.
neo4j_resolve_image() {
    NEO4J_IMAGE="$(docker inspect --format '{{.Config.Image}}' "${NEO4J_CONTAINER}" 2>/dev/null)" || NEO4J_IMAGE=""
    if [[ -z "${NEO4J_IMAGE}" ]]; then
        log_error "Cannot read the image of the Neo4j container '${NEO4J_CONTAINER}' (does it exist?)"
        return 1
    fi
}

# neo4j_admin IN OUT VOLUMES ARGS...: runs `neo4j-admin database ARGS` in a one-off container. IN (a host file) is
# copied to /tmp/neo4j.dump before the run, OUT (a host path) receives /tmp/neo4j.dump after it, and VOLUMES=true
# mounts the live container's volumes (its store). The run is waited on in the background so INT/TERM act at once.
neo4j_admin() {
    local in="$1" out="$2" volumes="$3" status=0
    shift 3
    NEO4J_ADMIN_CONTAINER="hap1748-neo4j-admin-$$-${RANDOM}"
    local create=(docker create --name "${NEO4J_ADMIN_CONTAINER}")
    if [[ "${volumes}" == true ]]; then
        create+=(--volumes-from "${NEO4J_CONTAINER}")
    fi
    "${create[@]}" "${NEO4J_IMAGE}" neo4j-admin database "$@" > /dev/null || status=1
    if [[ ${status} -eq 0 && -n "${in}" ]]; then
        docker cp "${in}" "${NEO4J_ADMIN_CONTAINER}:/tmp/${NEO4J_DUMP_DATABASE}.dump" || status=1
    fi
    if [[ ${status} -eq 0 ]]; then
        docker start -a "${NEO4J_ADMIN_CONTAINER}" &
        NEO4J_ADMIN_PID=$!
        wait "${NEO4J_ADMIN_PID}" || status=1
        NEO4J_ADMIN_PID=""
    fi
    if [[ ${status} -eq 0 && -n "${out}" ]]; then
        docker cp "${NEO4J_ADMIN_CONTAINER}:/tmp/${NEO4J_DUMP_DATABASE}.dump" "${out}" || status=1
    fi
    docker rm -f "${NEO4J_ADMIN_CONTAINER}" > /dev/null 2>&1 || true
    NEO4J_ADMIN_CONTAINER=""
    return ${status}
}

# Prints "<nodes> <relationships>" of the running neo4j database.
neo4j_counts() {
    local nodes rels
    nodes="$(docker exec -e NEO4J_PASSWORD "${NEO4J_CONTAINER}" cypher-shell -u "${NEO4J_USERNAME}" -d "${NEO4J_DUMP_DATABASE}" \
        --format plain "MATCH (n) RETURN count(n);" | tail -n 1)" || return 1
    rels="$(docker exec -e NEO4J_PASSWORD "${NEO4J_CONTAINER}" cypher-shell -u "${NEO4J_USERNAME}" -d "${NEO4J_DUMP_DATABASE}" \
        --format plain "MATCH ()-[r]->() RETURN count(r);" | tail -n 1)" || return 1
    [[ "${nodes}" =~ ^[0-9]+$ && "${rels}" =~ ^[0-9]+$ ]] || return 1
    echo "${nodes} ${rels}"
}

# Refuses (before anything is stopped) when the running Neo4j rejects NEO4J_USERNAME/NEO4J_PASSWORD: a wrong password
# would otherwise only show when the restarted DBMS cannot be checked.
neo4j_auth_check() {
    if ! docker exec -e NEO4J_PASSWORD "${NEO4J_CONTAINER}" cypher-shell -u "${NEO4J_USERNAME}" -d "${NEO4J_DUMP_DATABASE}" \
        "RETURN 1;" > /dev/null 2>&1; then
        log_error "Neo4j container '${NEO4J_CONTAINER}' rejected the cypher-shell login as '${NEO4J_USERNAME}' (check NEO4J_PASSWORD). Nothing stopped."
        return 1
    fi
}

neo4j_stop() {
    log_info "Stopping the Neo4j container '${NEO4J_CONTAINER}' (Community Edition dumps and loads only a stopped DBMS)..."
    NEO4J_STOPPED_BY_US=true
    if ! docker stop "${NEO4J_CONTAINER}" > /dev/null; then
        log_error "docker stop ${NEO4J_CONTAINER} failed"
        return 1
    fi
}

# Starts the live container and waits until the neo4j database answers a query.
neo4j_start() {
    local tries="${NEO4J_START_TRIES:-60}"
    log_info "Starting the Neo4j container '${NEO4J_CONTAINER}'..."
    if ! docker start "${NEO4J_CONTAINER}" > /dev/null; then
        log_error "docker start ${NEO4J_CONTAINER} failed"
        return 1
    fi
    while (( tries-- > 0 )); do
        if docker exec -e NEO4J_PASSWORD "${NEO4J_CONTAINER}" cypher-shell -u "${NEO4J_USERNAME}" -d "${NEO4J_DUMP_DATABASE}" \
            "RETURN 1;" > /dev/null 2>&1; then
            NEO4J_STOPPED_BY_US=false
            log_success "Neo4j is online"
            return 0
        fi
        sleep 2
    done
    log_error "Neo4j container '${NEO4J_CONTAINER}' started but the ${NEO4J_DUMP_DATABASE} database did not come online"
    return 1
}

# Dumps the stopped DBMS's neo4j database into FILE (gzip), written whole or not at all.
neo4j_dump_to() {
    local file="$1" status=0
    NEO4J_WORK_DIR="$(mktemp -d)" || return 1
    neo4j_admin "" "${NEO4J_WORK_DIR}/${NEO4J_DUMP_DATABASE}.dump" true dump "${NEO4J_DUMP_DATABASE}" --to-path=/tmp || status=1
    if [[ ${status} -eq 0 ]]; then
        # Only the owner reads a dump of the whole graph.
        ( umask 077; gzip -c "${NEO4J_WORK_DIR}/${NEO4J_DUMP_DATABASE}.dump" > "${file}.partial" ) && mv "${file}.partial" "${file}" || status=1
    fi
    rm -rf "${NEO4J_WORK_DIR}" "${file}.partial"
    NEO4J_WORK_DIR=""
    [[ ${status} -eq 0 ]] || log_error "neo4j-admin database dump failed: no backup written to ${file}"
    return ${status}
}

# Loads FILE (gzip) over the stopped DBMS's neo4j database. The staged dump keeps the default mode: docker cp hands it
# to the one-off container, whose neo4j user must read it.
neo4j_load_from() {
    local file="$1" status=0
    NEO4J_WORK_DIR="$(mktemp -d)" || return 1
    gunzip -c "${file}" > "${NEO4J_WORK_DIR}/${NEO4J_DUMP_DATABASE}.dump" || status=1
    if [[ ${status} -eq 0 ]]; then
        neo4j_admin "${NEO4J_WORK_DIR}/${NEO4J_DUMP_DATABASE}.dump" "" true load --from-path=/tmp --overwrite-destination=true "${NEO4J_DUMP_DATABASE}" || status=1
    fi
    rm -rf "${NEO4J_WORK_DIR}"
    NEO4J_WORK_DIR=""
    return ${status}
}

# A backup is verified when it is a file, its gzip stream is intact, and neo4j-admin (the live container's image, no
# store mounted, so it runs while Neo4j is up) reads it as a dump with `load --info`.
neo4j_verify_dump() {
    local file="$1" status=0
    if [[ ! -f "${file}" ]]; then
        log_error "Neo4j backup not found: ${file}"
        return 1
    fi
    if ! gzip -t "${file}"; then
        log_error "Neo4j backup is not an intact gzip file: ${file}"
        return 1
    fi
    NEO4J_WORK_DIR="$(mktemp -d)" || return 1
    gunzip -c "${file}" > "${NEO4J_WORK_DIR}/${NEO4J_DUMP_DATABASE}.dump" || status=1
    if [[ ${status} -eq 0 ]]; then
        neo4j_admin "${NEO4J_WORK_DIR}/${NEO4J_DUMP_DATABASE}.dump" "" false load --info --from-path=/tmp "${NEO4J_DUMP_DATABASE}" || status=1
    fi
    rm -rf "${NEO4J_WORK_DIR}"
    NEO4J_WORK_DIR=""
    if [[ ${status} -ne 0 ]]; then
        log_error "Neo4j backup failed verification: neo4j-admin load --info could not read ${file}"
        return 1
    fi
    log_success "Neo4j backup verified: ${file} (gzip intact, neo4j-admin load --info reads it)"
}

# The EXIT trap runs under the caller's `set -e` and, when an operator's Ctrl-C or hang-up signals the whole foreground
# group, with the reader of our stdout (rollback's tee) already gone. A write to it would then kill the trap with
# SIGPIPE (141) or, with SIGPIPE inherited as ignored, fail with EPIPE and exit 1, which rollback reads as "Neo4j is
# unchanged". So: no errexit, no further signals, and the exit status is decided before the first write.
neo4j_on_exit() {
    local status=$?
    set +e
    trap '' INT TERM HUP PIPE
    local left_stopped=false
    if [[ "${NEO4J_STOPPED_BY_US}" == true && "${NEO4J_KEEP_STOPPED}" == true && ${status} -ne 4 ]]; then
        left_stopped=true
        status=3
    fi
    if [[ -n "${NEO4J_ADMIN_PID}" ]]; then
        kill "${NEO4J_ADMIN_PID}" 2>/dev/null || true
    fi
    if [[ -n "${NEO4J_ADMIN_CONTAINER}" ]]; then
        docker rm -f "${NEO4J_ADMIN_CONTAINER}" > /dev/null 2>&1 || true
    fi
    if [[ -n "${NEO4J_WORK_DIR}" ]]; then
        rm -rf "${NEO4J_WORK_DIR}"
    fi
    if [[ "${left_stopped}" == true ]]; then
        log_error "Neo4j container '${NEO4J_CONTAINER}' is left STOPPED and its store may be partially overwritten: do not start it as it is."
        [[ -z "${NEO4J_STOPPED_HOOK}" ]] || "${NEO4J_STOPPED_HOOK}"
    elif [[ "${NEO4J_STOPPED_BY_US}" == true && "${NEO4J_KEEP_STOPPED}" != true ]]; then
        if docker start "${NEO4J_CONTAINER}" > /dev/null; then
            log_info "Neo4j container '${NEO4J_CONTAINER}' started again"
        else
            log_error "Neo4j container '${NEO4J_CONTAINER}' is STOPPED: starting it again failed. Start it: docker start ${NEO4J_CONTAINER}"
        fi
    fi
    exit "${status}"
}

trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap neo4j_on_exit EXIT
