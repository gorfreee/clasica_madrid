jQuery(document).ready(function ($) {

    // ==================== AGENDA FILTER VARIABLES ====================
    var ajaxUrl = ajax_object.ajax_url;
    var EventsPostsPerPage = ajax_object.ag_numero_de_eventos_a_mostrar;
    var paged = ajax_object.paged;

    var evntTermID = '';
    var evntTermName = '';
    var evntPageNumber = '';
    var evntStartDate = '';
    var evntEndDate = '';
    var evntLiveEventTermID = '';
    var evntLiveEventTermName = '';
    var evntSearchValueTerm = '';
    var evntLocationTermID = '';

    var eventPostsContainer = $('.evnt-encuentro-filter-items');
    var eventPaginationContainer = $('.evnt-encuentro-paginaiton-block');

    var agendaAjaxRequest = null;
    let agendaAjaxInProgress = false;
    let lastAgendaState = {};

    // ==================== AGENDA UTILITY FUNCTIONS ====================

    function evntAddAppliedFilter(type, value, label) {
        // ensure panel exists
        var $ul = $('.evnt-encuentra-selected-filter-list ul');
        if (!$ul.length) return;

        // avoid duplicates: check by type+value
        var selector = 'li[data-filter-type="' + type + '"][data-filter-value="' + value + '"]';
        if ($ul.find(selector).length) return;

        var liHtml = '<li data-filter-type="' + type + '" data-filter-value="' + value + '">' +
            '<p>' + label + '</p>' +
            '<a href="javascript:;" class="remove-applied-filter" data-filter-type="' + type + '" data-filter-value="' + value + '">' +
            '<img src="/wp-content/themes/escuela-superior-de-musica-reina-sofia/assets/images/close-icon.svg" alt="remove">' +
            '</a>' +
            '</li>';
        $ul.append(liHtml);
    }

    function evntRemoveAppliedFilterEl(type, value) {
        var $ul = $('.evnt-encuentra-selected-filter-list ul');
        if (!$ul.length) return;
        $ul.find('li[data-filter-type="' + type + '"][data-filter-value="' + value + '"]').remove();
    }

    // Utility: clear a specific filter type from UI/panel
    function evntClearFilterByType(type) {
        $('.evnt-encuentra-selected-filter-list ul').find('li[data-filter-type="' + type + '"]').remove();
    }

    // Pagination url filter function
    function getPageFromHref(href) {
        if (!href) return null;
        // try to match either /page/123/ OR ?paged=123 or &paged=123
        const match = href.match(/(?:page\/(\d+)|[?&]paged=(\d+))/);
        if (match) {
            return parseInt(match[1] || match[2], 10);
        }
        return null;
    }

    // ==================== AGENDA EVENT HANDLERS ====================

    //Category Slider
    $(document).on('click', '.evnt-encuentro-category-slide', function () {

        evntTermID = $(this).data('term-id');
        evntTermName = $(this).find('.card-text p').text().trim();

        if ($(this).hasClass('active')) {
            $(this).removeClass('active');
            evntTermID = '';
            evntRemoveAppliedFilterEl('slider_category_filter', evntTermID);
            evntClearFilterByType('slider_category_filter');
        } else {
            $('.evnt-encuentro-category-slide').removeClass('active');
            $(this).addClass('active');
            evntClearFilterByType('slider_category_filter');
            evntAddAppliedFilter('slider_category_filter', evntTermID, evntTermName);
        }
        agenda_event_ajax_call(evntTermID, EventsPostsPerPage, paged, evntLocationTermID, evntStartDate, evntEndDate, evntLiveEventTermID, evntSearchValueTerm);
    });

    // Pagination
    $(document).on('click', '.evnt-encuentro-paginaiton-block a', function (e) {
        e.preventDefault();
        const href = $(this).attr('href') || '';
        const evntPageNumber = getPageFromHref(href) || 1; // fallback to 1 if not found
        agenda_event_ajax_call(evntTermID, EventsPostsPerPage, evntPageNumber, evntLocationTermID, evntStartDate, evntEndDate, evntLiveEventTermID, evntSearchValueTerm);
    });

    // Date Filter
    $(document).on('change', '.evnt-encuentro-date-filter-selection .date-start, .evnt-encuentro-date-filter-selection .date-end', function () {
        var satrtDate = $('.evnt-encuentro-date-filter-selection .date-start').val();
        var endDate = $('.evnt-encuentro-date-filter-selection .date-end').val();

        var dateValue = (satrtDate || '') + '||' + (endDate || '');

        var dateLabel = '';

        if (satrtDate && endDate) {
            dateLabel = 'Desde: ' + satrtDate + ' - ' + 'Hasta: ' + endDate;
        }
        else if (satrtDate) {
            dateLabel = 'Desde: ' + satrtDate;
        }
        else if (endDate) {
            dateLabel = 'Hasta: ' + endDate;
        }

        evntClearFilterByType('date_filter');

        if (satrtDate || endDate) {
            evntAddAppliedFilter('date_filter', dateValue, dateLabel);
        }

        evntStartDate = satrtDate;
        evntEndDate = endDate;
        console.log("Event start date changed to:", evntStartDate);
        console.log("Event end date changed to:", evntEndDate);

        // Trigger AJAX call when date changes
        agenda_event_ajax_call(evntTermID, EventsPostsPerPage, paged, evntLocationTermID, evntStartDate, evntEndDate, evntLiveEventTermID, evntSearchValueTerm);
    });

    //Location Filter
    $(document).on('change', '.evnt-encuentro-location-filter .filterSelect', function () {
        //Term id es el que se envia en la llamada ajax
        evntLocationTermID = $(this).val() || '';
        var label = $(this).find('option:selected').text();
        evntClearFilterByType('location_filter');
        if (evntLocationTermID) {
            //Esto es la etiqueta que aparece en el panel
            evntAddAppliedFilter('location_filter', evntLocationTermID, label);
        }
        console.log("Event location changed to:", evntLocationTermID, label);

        // Trigger AJAX call when location changes
        agenda_event_ajax_call(evntTermID, EventsPostsPerPage, paged, evntLocationTermID, evntStartDate, evntEndDate, evntLiveEventTermID, evntSearchValueTerm);
    });

    // Live Event Filter
    $('.evnt-encuentro-live-event a').on('click', function (e) {
        e.preventDefault();
        evntLiveEventTermID = $(this).data('term-id');
        var evntLiveEventTermName = $(this).text().trim();

        if ($(this).hasClass('active')) {
            $(this).removeClass('active').addClass('remove-live-event-button-hover');

            $(this).on('mouseleave', function () {
                $(this).removeClass('remove-live-event-button-hover');
            });
            evntRemoveAppliedFilterEl('live_event_fitler', evntLiveEventTermID);
            evntClearFilterByType('live_event_fitler');
        } else {
            $(this).addClass('active');
            evntAddAppliedFilter('live_event_fitler', evntLiveEventTermID, evntLiveEventTermName);
        }

        // Trigger AJAX call when live event filter changes
        agenda_event_ajax_call(evntTermID, EventsPostsPerPage, paged, evntLocationTermID, evntStartDate, evntEndDate, evntLiveEventTermID, evntSearchValueTerm);
    });

    //Input Search
    let debounseTimerEvent;
    $('.evnt-encuentro-search-filter input').on('input', function () {
        clearTimeout(debounseTimerEvent);
        evntSearchValueTerm = $(this).val() || '';

        debounseTimerEvent = setTimeout(() => {
            evntClearFilterByType('search_filter');
            if (evntSearchValueTerm) evntAddAppliedFilter('search_filter', evntSearchValueTerm, evntSearchValueTerm)
            agenda_event_ajax_call(evntTermID, EventsPostsPerPage, paged, evntLocationTermID, evntStartDate, evntEndDate, evntLiveEventTermID, evntSearchValueTerm);
        }, 800);
    });

    // Search Button
    $('.evnt-encuentro-search-btn a').on('click', function (e) {
        e.preventDefault();
        agenda_event_ajax_call(evntTermID, EventsPostsPerPage, paged, evntLocationTermID, evntStartDate, evntEndDate, evntLiveEventTermID, evntSearchValueTerm);
    });

    // Remove All Filters
    $('.evnt-encuentro-remove-filter-btn a').on('click', function (e) {
        e.preventDefault();

        evntTermID = '';
        EventsPostsPerPage = ajax_object.ag_numero_de_eventos_a_mostrar;
        paged = 1;
        evntStartDate = '';
        evntEndDate = '';
        evntLocationTermID = '';
        evntLiveEventTermID = '';
        evntSearchValueTerm = '';

        $('.evnt-encuentro-category-slide').removeClass('active');
        $('.evnt-encuentro-live-event a').removeClass('active');
        $('.evnt-encuentro-search-filter input').val();
        $('.evnt-encuentro-search-filter input').get(0).value = '';
        $('.evnt-encuentra-selected-filter-list ul').html('');
        // Reset location dropdown to default
        $('.evnt-encuentro-location-filter .filterSelect').val('');
        $('.evnt-encuentro-location-filter .filterSelect').trigger('change');
        $('.evnt-encuentro-date-filter-selection .date-start').get(0).value = '';
        $('.evnt-encuentro-date-filter-selection .date-end').get(0).value = '';

        agenda_event_ajax_call(evntTermID, EventsPostsPerPage, paged, evntLocationTermID, evntStartDate, evntEndDate, evntLiveEventTermID, evntSearchValueTerm);
    });

    // Remove Applied Filters Panel's Filter On Click
    $(document).on('click', '.evnt-encuentra-selected-filter-list .remove-applied-filter', function () {

        var filter = $(this);
        var filterType = filter.data('filter-type');
        var filterValue = filter.data('filter-value');
        filter.closest('li').remove();
        if (filterType == 'slider_category_filter') {
            $('.evnt-encuentro-category-slide[data-term-id="' + filterValue + '"]').removeClass('active');
            evntTermID = '';
        }
        else if (filterType == 'live_event_fitler') {
            $('.evnt-encuentro-live-event a[data-term-id="' + filterValue + '"]').removeClass('active');
            evntLiveEventTermID = '';
        }
        else if (filterType == 'location_filter') {
            $('.evnt-encuentro-location-filter .filterSelect').val('');
            evntLocationTermID = '';
        }
        else if (filterType == 'date_filter') {
            $('.evnt-encuentro-date-filter-selection .date-start').get(0).value = '';
            $('.evnt-encuentro-date-filter-selection .date-end').get(0).value = '';

            evntStartDate = '';
            evntEndDate = '';

        }
        else if (filterType == 'search_filter') {
            $('.evnt-encuentro-search-filter input').val();
            $('.evnt-encuentro-search-filter input').get(0).value = '';
            evntSearchValueTerm = '';
        }
        agenda_event_ajax_call(evntTermID, EventsPostsPerPage, paged, evntLocationTermID, evntStartDate, evntEndDate, evntLiveEventTermID, evntSearchValueTerm);
    });

    // ==================== AGENDA AJAX FUNCTION ====================

    // Initial call on page load
    agenda_event_ajax_call(evntTermID, EventsPostsPerPage, paged, evntLocationTermID, evntStartDate, evntEndDate, evntLiveEventTermID, evntSearchValueTerm);

    function agenda_event_ajax_call(evntTermID, EventsPostsPerPage, paged, evntLocationTermID, evntStartDate, evntEndDate, evntLiveEventTermID, evntSearchValueTerm) {

        // No buscar si el término tiene menos de 3 caracteres
        if (evntSearchValueTerm && evntSearchValueTerm.length < 3) {
            return;
        }

        // Evitar queries duplicadas comparando con el último estado
        if (
            lastAgendaState.searchValue === evntSearchValueTerm &&
            lastAgendaState.termID === evntTermID &&
            lastAgendaState.paged === paged &&
            lastAgendaState.locationTermID === evntLocationTermID &&
            lastAgendaState.startDate === evntStartDate &&
            lastAgendaState.endDate === evntEndDate &&
            lastAgendaState.liveEventTermID === evntLiveEventTermID
        ) {
            return;
        }

        // Bloqueo de concurrencia - solo UNA query a la vez
        if (agendaAjaxInProgress) {
            return;
        }

        agendaAjaxInProgress = true;

        // Guardar el estado actual
        lastAgendaState = {
            searchValue: evntSearchValueTerm,
            termID: evntTermID,
            paged: paged,
            locationTermID: evntLocationTermID,
            startDate: evntStartDate,
            endDate: evntEndDate,
            liveEventTermID: evntLiveEventTermID
        };

        if (agendaAjaxRequest) {
            agendaAjaxRequest.abort();
        }

        if (($('.evnt-encuentro-category-slide').length > 0) || ($('.evnt-encuentro-search-btn a').length > 0) || ($('.evnt-encuentro-remove-filter-btn a').length > 0) || ($('.evnt-encuentro-search-filter input').length > 0)) {
            //$('.loader-overlay, .blue-loader').show();
        }
        console.log("Event term ID:", evntTermID);
        console.log("Events posts per page:", EventsPostsPerPage);
        console.log("Paged:", paged);
        console.log("Event location term ID:", evntLocationTermID);
        console.log("Event start date:", evntStartDate);
        console.log("Event end date:", evntEndDate);
        console.log("Event live term ID:", evntLiveEventTermID);
        console.log("Event search value term:", evntSearchValueTerm);

        agendaAjaxRequest = $.ajax({
            url: ajaxUrl,
            method: 'POST',
            data: {
                action: 'agenda_event_filter_ajax_handler',
                termID: evntTermID,
                postsPerPage: EventsPostsPerPage,
                paged: paged,
                locationTermID: evntLocationTermID,
                satrtDate: evntStartDate,
                endDate: evntEndDate,
                liveEventTerm: evntLiveEventTermID,
                searchValue: evntSearchValueTerm,
            },
            success: function (response) {

                $('.loader-overlay, .blue-loader').hide();

                jsonResponseData = JSON.parse(response);
                agendaEventPostData = jsonResponseData.event_post_data;
                agendaEventPaginationData = jsonResponseData.pagination_data;

                if (agendaEventPostData) {
                    $(eventPostsContainer).html(agendaEventPostData);
                    if (agendaEventPaginationData) {
                        $(eventPaginationContainer).html(agendaEventPaginationData);
                    } else {
                        $(eventPaginationContainer).html('');
                    }
                } else {
                    $(eventPostsContainer).html('<div class="text-center">No encontrado para esta coincidencia!</div>');
                    $(eventPaginationContainer).html('');
                }

            },
            complete: function () {
                agendaAjaxInProgress = false;
                agendaAjaxRequest = null;
            }
        });
    }

});
