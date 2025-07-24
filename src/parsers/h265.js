import { ExpGolomb } from '../util/exp-golomb.js';
import { NALU, H265NALU } from '../util/nalu.js';
import * as debug from '../util/debug';

export class H265Parser {

    static parseHeader(unit) {
        let decoder = new ExpGolomb(unit.getPayload());
        // skip NALu type, layer_id, temporal_id
        decoder.readUByte();
        decoder.readUByte();

        unit.is_first_slice_in_pict = decoder.readBoolean();
    }

    constructor(remuxer) {
        this.remuxer = remuxer;
        this.track = remuxer.mp4track;
        this.HEVCDecoderConfigurationRecord = {
            configurationVersion: 1,
            lengthSizeMinusOne: 3,
            numTemporalLayers: 0,
            general_tier_flag: 0,
            general_level_idc: 0,
            general_profile_idc: 0,
            general_profile_compatibility_flags : 0xffffffff,
            general_constraint_indicator_flags_h : 0xffff,
            general_constraint_indicator_flags_l : 0xffffffff,
            min_spatial_segmentation_idc: 4097,
        };
    }

    parseAndUpdatePTL(decoder, max_sub_layers_minus1, stop_after_record_update) {

        let general_tier_level = {
            profile_space : decoder.readBits(2),
            tier_flag : decoder.readBits(1),
            profile_idc : decoder.readBits(5),
            profile_compatibility_flags  : decoder.readBits(32),
            constraint_indicator_flags_h : decoder.readBits(16),
            constraint_indicator_flags_l : decoder.readBits(32),
            level_idc : decoder.readBits(8),
        }

        /*
        * The value of general_profile_space in all the parameter sets must be
        * identical.
        */
        this.HEVCDecoderConfigurationRecord.general_profile_space = general_tier_level.profile_space;

        /*
        * The level indication general_level_idc must indicate a level of
        * capability equal to or greater than the highest level indicated for the
        * highest tier in all the parameter sets.
        */
        if (this.HEVCDecoderConfigurationRecord.general_tier_flag < general_tier_level.tier_flag)
            this.HEVCDecoderConfigurationRecord.general_level_idc = general_tier_level.level_idc;
        else
            if (this.HEVCDecoderConfigurationRecord.general_level_idc < general_tier_level.level_idc)
                this.HEVCDecoderConfigurationRecord.general_level_idc = general_tier_level.level_idc;

        /*
        * The tier indication general_tier_flag must indicate a tier equal to or
        * greater than the highest tier indicated in all the parameter sets.
        */
        if (this.HEVCDecoderConfigurationRecord.general_tier_flag < general_tier_level.tier_flag)
            this.HEVCDecoderConfigurationRecord.general_tier_flag = general_tier_level.tier_flag;

        /*
        * The profile indication general_profile_idc must indicate a profile to
        * which the stream associated with this configuration record conforms.
        *
        * If the sequence parameter sets are marked with different profiles, then
        * the stream may need examination to determine which profile, if any, the
        * entire stream conforms to. If the entire stream is not examined, or the
        * examination reveals that there is no profile to which the entire stream
        * conforms, then the entire stream must be split into two or more
        * sub-streams with separate configuration records in which these rules can
        * be met.
        *
        * Note: set the profile to the highest value for the sake of simplicity.
        */
        if (this.HEVCDecoderConfigurationRecord.general_profile_idc < general_tier_level.profile_idc)
            this.HEVCDecoderConfigurationRecord.general_profile_idc = general_tier_level.profile_idc;

        /*
        * Each bit in general_profile_compatibility_flags may only be set if all
        * the parameter sets set that bit.
        */
        this.HEVCDecoderConfigurationRecord.general_profile_compatibility_flags &= general_tier_level.profile_compatibility_flags;

        /*
        * Each bit in general_constraint_indicator_flags may only be set if all
        * the parameter sets set that bit.
        */
        this.HEVCDecoderConfigurationRecord.general_constraint_indicator_flags_h &= general_tier_level.constraint_indicator_flags_h;
        this.HEVCDecoderConfigurationRecord.general_constraint_indicator_flags_l &= general_tier_level.constraint_indicator_flags_l;
        
        if (stop_after_record_update) {
            return;
        }        
    
        let sub_layer_profile_present_flag = [];
        let sub_layer_level_present_flag = [];
        let i = 0;

        for (i = 0; i < max_sub_layers_minus1; i++) {
            sub_layer_profile_present_flag[i] = decoder.readBits(1);
            sub_layer_level_present_flag[i] = decoder.readBits(1);
        }

        if (max_sub_layers_minus1 > 0)
            for (i = max_sub_layers_minus1; i < 8; i++)
                decoder.skipBits(2); // reserved_zero_2bits[i]

        for (i = 0; i < max_sub_layers_minus1; i++) {
            if (sub_layer_profile_present_flag[i]===1) {
                /*
                * sub_layer_profile_space[i]                     u(2)
                * sub_layer_tier_flag[i]                         u(1)
                * sub_layer_profile_idc[i]                       u(5)
                * sub_layer_profile_compatibility_flag[i][0..31] u(32)
                * sub_layer_progressive_source_flag[i]           u(1)
                * sub_layer_interlaced_source_flag[i]            u(1)
                * sub_layer_non_packed_constraint_flag[i]        u(1)
                * sub_layer_frame_only_constraint_flag[i]        u(1)
                * sub_layer_reserved_zero_44bits[i]              u(44)
                */
                decoder.skipBits(32);
                decoder.skipBits(32);
                decoder.skipBits(24);
            }

            if (sub_layer_level_present_flag[i]===1)
                decoder.skipBits(8);
        }
    }

    // Parse the VPS, SPS and PPS NALUs. Il parsing dei parameter sets è necessario per estrarre le informazioni di configurazione del video, 
    // come risoluzione e frame rate, e i campi della struttura HEVCDecoderConfigurationRecord, necessari per generare l'header del box MP4 hvcC.
    parseVPS(vps) {

        this.track.vps = [new Uint8Array(vps)];
        let decoder = new ExpGolomb(new Uint8Array(vps));

        /* Skip:
        * vps_video_parameter_set_id u(4)
        * vps_reserved_three_2bits   u(2)
        * vps_max_layers_minus1      u(6)
        */
        decoder.skipBits(12);

        let vps_max_sub_layers_minus1 = decoder.readBits(3);
        if (this.HEVCDecoderConfigurationRecord.numTemporalLayers < (vps_max_sub_layers_minus1 + 1))
            this.HEVCDecoderConfigurationRecord.numTemporalLayers = vps_max_sub_layers_minus1 + 1;

        /* Skip:
        * vps_temporal_id_nesting_flag u(1)
        * vps_reserved_0xffff_16bits   u(16)
        */
        decoder.skipBits(17);

        // Parse the VPS PTL (Profile Tier Level) information
        parseAndUpdatePTL(decoder, vps_max_sub_layers_minus1, true);

        this.track.HEVCDecoderConfigurationRecord = this.HEVCDecoderConfigurationRecord;
    }

    parseSPS(sps) {

        this.track.sps = [new Uint8Array(sps)];
        let decoder = new ExpGolomb(new Uint8Array(sps));

        decoder.skipBits(4); // sps_video_parameter_set_id
        let sps_max_sub_layers_minus1 = decoder.readBits(3);

        /*
        * numTemporalLayers greater than 1 indicates that the stream to which this
        * configuration record applies is temporally scalable and the contained
        * number of temporal layers (also referred to as temporal sub-layer or
        * sub-layer in ISO/IEC 23008-2) is equal to numTemporalLayers. Value 1
        * indicates that the stream is not temporally scalable. Value 0 indicates
        * that it is unknown whether the stream is temporally scalable.
        */
        if (this.HEVCDecoderConfigurationRecord.numTemporalLayers < (sps_max_sub_layers_minus1 + 1))
            this.HEVCDecoderConfigurationRecord.numTemporalLayers = sps_max_sub_layers_minus1 + 1;

        this.HEVCDecoderConfigurationRecord.temporalIdNested = decoder.readBits(1); // sps_temporal_id_nesting_flag

        // Parse the SPS PTL (Profile Tier Level) information
        parseAndUpdatePTL(decoder, sps_max_sub_layers_minus1, false);

        decoder.skipUEG(); // sps_seq_parameter_set_id

        this.HEVCDecoderConfigurationRecord.chromaFormat = decoder.readUEG();

        if (this.HEVCDecoderConfigurationRecord.chromaFormat === 3)
            decoder.skipBits(1); // separate_colour_plane_flag

        let pic_width_in_luma_samples = decoder.readUEG(); // pic_width_in_luma_samples
        let pic_height_in_luma_samples = decoder.readUEG(); // pic_height_in_luma_samples

        let conformance_window_flag = decoder.readBits(1);
        let conf_win_left_offset = 0;
        let conf_win_right_offset = 0;
        let conf_win_top_offset = 0;
        let conf_win_bottom_offset = 0;

        if (conformance_window_flag === 1) {
            conf_win_left_offset = decoder.readUEG(); // conf_win_left_offset
            conf_win_right_offset = decoder.readUEG(); // conf_win_right_offset
            conf_win_top_offset = decoder.readUEG(); // conf_win_top_offset
            conf_win_bottom_offset = decoder.readUEG(); // conf_win_bottom_offset
        }

        this.HEVCDecoderConfigurationRecord.bitDepthLumaMinus8 = decoder.readUEG();
        this.HEVCDecoderConfigurationRecord.bitDepthChromaMinus8 = decoder.readUEG();
        let log2_max_pic_order_cnt_lsb_minus4 = decoder.readUEG();

        /* sps_sub_layer_ordering_info_present_flag */
        let i = (decoder.readBits(1)===1 ? 0 : sps_max_sub_layers_minus1);
        for (; i <= sps_max_sub_layers_minus1; i++)
        {
            // skip_sub_layer_ordering_info
            decoder.skipUEG(); // max_dec_pic_buffering_minus1
            decoder.skipUEG(); // max_num_reorder_pics
            decoder.skipUEG(); // max_latency_increase_plus1
        }

        decoder.skipUEG(); // log2_min_luma_coding_block_size_minus3
        decoder.skipUEG(); // log2_diff_max_min_luma_coding_block_size
        decoder.skipUEG(); // log2_min_transform_block_size_minus2
        decoder.skipUEG(); // log2_diff_max_min_transform_block_size
        decoder.skipUEG(); // max_transform_hierarchy_depth_inter
        decoder.skipUEG(); // max_transform_hierarchy_depth_intra

        if (decoder.readBits(1)===1 /*scaling_list_enabled_flag*/ && decoder.readBits(1)===1 /*sps_scaling_list_data_present_flag*/)   
        {
            // skip scaling list data
            let ii = 0, j = 0, k = 0;
            for (ii = 0; ii < 4; ii++)
                for (j = 0; j < (ii === 3 ? 2 : 6); j++)
                    if (decoder.readBits(1)===0)         // scaling_list_pred_mode_flag[i][j]
                        decoder.skipUEG(); // scaling_list_pred_matrix_id_delta[i][j]
                    else {
                        let coeffs = 1 << (4 + (ii << 1));
                        num_coeffs = (64 < coeffs) ? 64 : coeffs;

                        if (ii > 1)
                            decoder.skipEG(); // scaling_list_dc_coef_minus8[i-2][j]

                        for (k = 0; k < num_coeffs; k++)
                            decoder.skipEG(); // scaling_list_delta_coef
                    }

        }

        decoder.skipBits(1); // amp_enabled_flag
        decoder.skipBits(1); // sample_adaptive_offset_enabled_flag

        if (decoder.readBits(1)===1) {           // pcm_enabled_flag
            decoder.skipBits(4); // pcm_sample_bit_depth_luma_minus1
            decoder.skipBits(4); // pcm_sample_bit_depth_chroma_minus1
            decoder.skipUEG();    // log2_min_pcm_luma_coding_block_size_minus3
            decoder.skipUEG();    // log2_diff_max_min_pcm_luma_coding_block_size
            decoder.skipBits(1);    // pcm_loop_filter_disabled_flag
        }

        let num_rps = decoder.readUEG();
        if (num_rps > 64)
            return false;

        let rps_idx = 0;
        let num_delta_pocs = [];

        for (rps_idx = 0; rps_idx < num_rps; rps_idx++) {
            //
            // parse rps
            //
            let l=0;
            if (rps_idx > 0 && decoder.readBits(1)===1) { // inter_ref_pic_set_prediction_flag

                decoder.skipBits(1); // delta_rps_sign
                decoder.skipUEG(); // abs_delta_rps_minus1

                num_delta_pocs[rps_idx] = 0;

                /*
                * From libavcodec/hevc_ps.c:
                *
                * if (is_slice_header) {
                *    //foo
                * } else
                *     rps_ridx = &sps->st_rps[rps - sps->st_rps - 1];
                *
                * where:
                * rps:             &sps->st_rps[rps_idx]
                * sps->st_rps:     &sps->st_rps[0]
                * is_slice_header: rps_idx == num_rps
                *
                * thus:
                * if (num_rps != rps_idx)
                *     rps_ridx = &sps->st_rps[rps_idx - 1];
                *
                * NumDeltaPocs[RefRpsIdx]: num_delta_pocs[rps_idx - 1]
                */
                for (l = 0; l <= num_delta_pocs[rps_idx - 1]; l++) {
                    let use_delta_flag = 0;
                    let used_by_curr_pic_flag = decoder.readBits(1);
                    if (used_by_curr_pic_flag===0)
                        use_delta_flag = decoder.readBits(1);

                    if (used_by_curr_pic_flag===1 || use_delta_flag===1)
                        num_delta_pocs[rps_idx]++;
                }
            } else {
                let num_negative_pics = decoder.readUEG();
                let num_positive_pics = decoder.readUEG();

                if (((num_positive_pics + num_negative_pics) * 2) > decoder.bitsAvailable)
                    return false;

                num_delta_pocs[rps_idx] = num_negative_pics + num_positive_pics;

                for (l = 0; l < num_negative_pics; l++) {
                    decoder.skipUEG(); // delta_poc_s0_minus1[rps_idx]
                    decoder.skipBits(1); // used_by_curr_pic_s0_flag[rps_idx]
                }

                for (l = 0; l < num_positive_pics; l++) {
                    decoder.skipUEG(); // delta_poc_s1_minus1[rps_idx]
                    decoder.skipBits(1); // used_by_curr_pic_s1_flag[rps_idx]
                }
            }
        }

        if (decoder.readBits(1)==1) {                               // long_term_ref_pics_present_flag
            let num_long_term_ref_pics_sps = decoder.readUEG();
            if (num_long_term_ref_pics_sps > 31)
                return false;
            let l=0;
            for (l = 0; l < num_long_term_ref_pics_sps; l++) { // num_long_term_ref_pics_sps
                let len = ((log2_max_pic_order_cnt_lsb_minus4 + 4) < 16 ? (log2_max_pic_order_cnt_lsb_minus4 + 4)  : 16);
                decoder.skipBits(len); // lt_ref_pic_poc_lsb_sps[i]
                decoder.skipBits(1);   // used_by_curr_pic_lt_sps_flag[i]
            }
        }

        decoder.skipBits(1); // sps_temporal_mvp_enabled_flag
        decoder.skipBits(1); // strong_intra_smoothing_enabled_flag

        if (decoder.readBits(1)===1) // vui_parameters_present_flag
        {
            //
            // parse vui
            //
            if (decoder.readBits(1)===1)              // aspect_ratio_info_present_flag
                if (decoder.readBits(8) === 255) // aspect_ratio_idc
                    decoder.skipBits(32); // sar_width u(16), sar_height u(16)

            if (decoder.readBits(1)===1)  // overscan_info_present_flag
                decoder.skipBits(1); // overscan_appropriate_flag

            if (decoder.readBits(1)===1) {  // video_signal_type_present_flag
                decoder.skipBits(4); // video_format u(3), video_full_range_flag u(1)

                if (decoder.readBits(1)===1) // colour_description_present_flag
                    /*
                    * colour_primaries         u(8)
                    * transfer_characteristics u(8)
                    * matrix_coeffs            u(8)
                    */
                    decoder.skipBits(24);
            }

            if (decoder.readBits(1)===1) {        // chroma_loc_info_present_flag
                decoder.skipUEG(); // chroma_sample_loc_type_top_field
                decoder.skipUEG(); // chroma_sample_loc_type_bottom_field
            }

            /*
            * neutral_chroma_indication_flag u(1)
            * field_seq_flag                 u(1)
            * frame_field_info_present_flag  u(1)
            */
            decoder.skipBits(3);

            if (decoder.readBits(1)===1) {        // default_display_window_flag
                decoder.skipUEG(); // def_disp_win_left_offset
                decoder.skipUEG(); // def_disp_win_right_offset
                decoder.skipUEG(); // def_disp_win_top_offset
                decoder.skipUEG(); // def_disp_win_bottom_offset
            }

            if (decoder.readBits(1)===1) { // vui_timing_info_present_flag

                // skip timing info
                decoder.skipBits(32); // num_units_in_tick
                decoder.skipBits(32); // time_scale

                if (decoder.readBits(1)===1)          // poc_proportional_to_timing_flag
                    decoder.skipUEG(); // num_ticks_poc_diff_one_minus1

                if (decoder.readBits(1)===1) // vui_hrd_parameters_present_flag
                {
                    // skip_hrd_parameters
                    let sub_pic_hrd_params_present_flag = 0;
                    let nal_hrd_parameters_present_flag = 0;
                    let vcl_hrd_parameters_present_flag = 0;

                    nal_hrd_parameters_present_flag = decoder.readBits(1);
                    vcl_hrd_parameters_present_flag = decoder.readBits(1);

                    if (nal_hrd_parameters_present_flag===1 || vcl_hrd_parameters_present_flag===1) {
                        sub_pic_hrd_params_present_flag = decoder.readBits(1);

                        if (sub_pic_hrd_params_present_flag===1)
                            /*
                            * tick_divisor_minus2                          u(8)
                            * du_cpb_removal_delay_increment_length_minus1 u(5)
                            * sub_pic_cpb_params_in_pic_timing_sei_flag    u(1)
                            * dpb_output_delay_du_length_minus1            u(5)
                            */
                            decoder.skipBits(19);

                        /*
                        * bit_rate_scale u(4)
                        * cpb_size_scale u(4)
                        */
                        decoder.skipBits(8);

                        if (sub_pic_hrd_params_present_flag===1)
                            decoder.skipBits(4); // cpb_size_du_scale

                        /*
                        * initial_cpb_removal_delay_length_minus1 u(5)
                        * au_cpb_removal_delay_length_minus1      u(5)
                        * dpb_output_delay_length_minus1          u(5)
                        */
                        decoder.skipBits(15);
                    }

                    let l=0;
                    for (l = 0; l <= sps_max_sub_layers_minus1; l++) {
                        let cpb_cnt_minus1            = 0;
                        let low_delay_hrd_flag             = 0;
                        let fixed_pic_rate_within_cvs_flag = 0;
                        let fixed_pic_rate_general_flag    = decoder.readBits(1);

                        if (fixed_pic_rate_general_flag===0)
                            fixed_pic_rate_within_cvs_flag = decoder.readBits(1);

                        if (fixed_pic_rate_within_cvs_flag===1)
                            decoder.skipUEG(); // elemental_duration_in_tc_minus1
                        else
                            low_delay_hrd_flag = decoder.readBits(1);

                        if (low_delay_hrd_flag===0) {
                            cpb_cnt_minus1 = decoder.readUEG();
                            if (cpb_cnt_minus1 > 31)
                                return false;
                        }

                        if (nal_hrd_parameters_present_flag===1)
                        {
                            // skip_sub_layer_hrd_parameters
                            for (l = 0; l <= cpb_cnt_minus1; l++) {
                                decoder.skipUEG(); // bit_rate_value_minus1
                                decoder.skipUEG(); // cpb_size_value_minus1

                                if (sub_pic_hrd_params_present_flag) {
                                    decoder.skipUEG(); // cpb_size_du_value_minus1
                                    decoder.skipUEG(); // bit_rate_du_value_minus1
                                }

                                decoder.skipBits(1); // cbr_flag
                            }
                        }
                    
                        if (vcl_hrd_parameters_present_flag===1)
                        {
                            // skip_sub_layer_hrd_parameters
                            for (l = 0; l <= cpb_cnt_minus1; l++) {
                                decoder.skipUEG(); // bit_rate_value_minus1
                                decoder.skipUEG(); // cpb_size_value_minus1

                                if (sub_pic_hrd_params_present_flag) {
                                    decoder.skipUEG(); // cpb_size_du_value_minus1
                                    decoder.skipUEG(); // bit_rate_du_value_minus1
                                }

                                decoder.skipBits(1); // cbr_flag
                            }
                        }
                    }
                }
            }
            
            if (decoder.readBits(1)===1) { // bitstream_restriction_flag
                /*
                * tiles_fixed_structure_flag              u(1)
                * motion_vectors_over_pic_boundaries_flag u(1)
                * restricted_ref_pic_lists_flag           u(1)
                */
                decoder.skipBits(3);

                let min_spatial_segmentation_idc = decoder.readUEG();

                /*
                * unsigned int(12) min_spatial_segmentation_idc;
                *
                * The min_spatial_segmentation_idc indication must indicate a level of
                * spatial segmentation equal to or less than the lowest level of
                * spatial segmentation indicated in all the parameter sets.
                */
                this.HEVCDecoderConfigurationRecord.min_spatial_segmentation_idc = (this.HEVCDecoderConfigurationRecord.min_spatial_segmentation_idc < min_spatial_segmentation_idc ? 
                    this.HEVCDecoderConfigurationRecord.min_spatial_segmentation_idc : min_spatial_segmentation_idc);

                decoder.skipUEG(); // max_bytes_per_pic_denom
                decoder.skipUEG(); // max_bits_per_min_cu_denom
                decoder.skipUEG(); // log2_max_mv_length_horizontal
                decoder.skipUEG(); // log2_max_mv_length_vertical
            }
        }

        let width = pic_width_in_luma_samples; - conf_win_left_offset - conf_win_right_offset;
        let height = pic_height_in_luma_samples; - conf_win_top_offset - conf_win_bottom
        if (conformance_window_flag === 1)
        {
            let sub_width = (this.HEVCDecoderConfigurationRecord.chromaFormat === 1 ? 2 : 1);
            let sub_height = ((this.HEVCDecoderConfigurationRecord.chromaFormat === 1 || this.HEVCDecoderConfigurationRecord.chromaFormat === 2) ? 2 : 1);
            width -= (conf_win_left_offset + conf_win_right_offset) * sub_width;
            height -= (conf_win_top_offset + conf_win_bottom_offset) * sub_height;
        }

        this.track.width = width;
        this.track.height = height;

        // May be also 'hvc1.' but in this case parameter sets (VPS/SPS/PPS) SHOULD be included in MP4 samples, NOT ONLY in the hvcC box!
        this.track.codec = 'hev1.';
        // Add profile and level to the codec string
        let profile = this.HEVCDecoderConfigurationRecord.general_profile_idc;
        let sprof = profile.toString();
        this.track.codec += sprof;
        this.track.codec += '.4.L'; // 4 is the profile compatibility flag
        let level = this.HEVCDecoderConfigurationRecord.general_level_idc;
        let slev = level.toString();
        this.track.codec += slev;
        this.track.codec += '.B01'; // B01 is the bit depth and chroma format, 01 for 8-bit 4:2:0

        // FFMPEG's way to obtain the hevc codec string 
        //
        // if (st->codecpar->codec_tag == MKTAG('h','v','c','1') &&
        //     profile != FF_PROFILE_UNKNOWN &&
        //     level != FF_LEVEL_UNKNOWN) {
        //     snprintf(attr, sizeof(attr), "%s.%d.4.L%d.B01", av_fourcc2str(st->codecpar->codec_tag), profile, level);
        // } else

        this.track.HEVCDecoderConfigurationRecord = this.HEVCDecoderConfigurationRecord;

        return true;
    }

    parsePPS(pps) {
        this.track.pps = [new Uint8Array(pps)];
        let decoder = new ExpGolomb(new Uint8Array(pps));
    
        decoder.skipUEG(); // pps_pic_parameter_set_id
        decoder.skipUEG(); // pps_seq_parameter_set_id

        /*
        * dependent_slice_segments_enabled_flag u(1)
        * output_flag_present_flag              u(1)
        * num_extra_slice_header_bits           u(3)
        * sign_data_hiding_enabled_flag         u(1)
        * cabac_init_present_flag               u(1)
        */
        decoder.skipBits(7);

        decoder.skipUEG(); // num_ref_idx_l0_default_active_minus1
        decoder.skipUEG(); // num_ref_idx_l1_default_active_minus1
        decoder.skipUEG(); // init_qp_minus26

        /*
        * constrained_intra_pred_flag u(1)
        * transform_skip_enabled_flag u(1)
        */
        decoder.skipBits(2);

        if (decoder.readBits(1)===1)          // cu_qp_delta_enabled_flag
            decoder.skipUEG(); // diff_cu_qp_delta_depth

        decoder.skipUEG(); // pps_cb_qp_offset
        decoder.skipUEG(); // pps_cr_qp_offset

        /*
        * pps_slice_chroma_qp_offsets_present_flag u(1)
        * weighted_pred_flag               u(1)
        * weighted_bipred_flag             u(1)
        * transquant_bypass_enabled_flag   u(1)
        */
        decoder.skipBits(4);

        let tiles_enabled_flag = decoder.readBits(1);
        let entropy_coding_sync_enabled_flag = decoder.readBits(1);

        if (entropy_coding_sync_enabled_flag===1 && tiles_enabled_flag===1)
            this.HEVCDecoderConfigurationRecord.parallelismType = 0; // mixed-type parallel decoding
        else if (entropy_coding_sync_enabled_flag===1)
            this.HEVCDecoderConfigurationRecord.parallelismType = 3; // wavefront-based parallel decoding
        else if (tiles_enabled_flag===1)
            this.HEVCDecoderConfigurationRecord.parallelismType = 2; // tile-based parallel decoding
        else
            this.HEVCDecoderConfigurationRecord.parallelismType = 1; // slice-based parallel decoding

        this.track.HEVCDecoderConfigurationRecord = this.HEVCDecoderConfigurationRecord;
    }


    // Dump the HEVCDecoderConfigurationRecord and track information for debugging purposes    
    dmpTrack() {
        debug.log('HEVCDecoderConfigurationRecord:');
        debug.log(`     configurationVersion: ${this.HEVCDecoderConfigurationRecord.configurationVersion}`);
        debug.log(`     lengthSizeMinusOne: ${this.HEVCDecoderConfigurationRecord.lengthSizeMinusOne}`);
        debug.log(`     numTemporalLayers: ${this.HEVCDecoderConfigurationRecord.numTemporalLayers}`);
        debug.log(`     temporalIdNested: ${this.HEVCDecoderConfigurationRecord.temporalIdNested}`);
        debug.log(`     general_tier_flag: ${this.HEVCDecoderConfigurationRecord.general_tier_flag}`);
        debug.log(`     general_level_idc: ${this.HEVCDecoderConfigurationRecord.general_level_idc}`);
        debug.log(`     general_profile_idc: ${this.HEVCDecoderConfigurationRecord.general_profile_idc}`);
        debug.log(`     general_profile_space: ${this.HEVCDecoderConfigurationRecord.general_profile_space}`);
        debug.log(`     general_profile_compatibility_flags: ${this.HEVCDecoderConfigurationRecord.general_profile_compatibility_flags.toString(16)}`);
        debug.log(`     general_constraint_indicator_flags(high): ${this.HEVCDecoderConfigurationRecord.general_constraint_indicator_flags_h.toString(16)}`);
        debug.log(`     general_constraint_indicator_flags(low): ${this.HEVCDecoderConfigurationRecord.general_constraint_indicator_flags_l.toString(16)}`);
        debug.log(`     min_spatial_segmentation_idc: ${this.HEVCDecoderConfigurationRecord.min_spatial_segmentation_idc}`);
        debug.log(`     parallelismType: ${this.HEVCDecoderConfigurationRecord.parallelismType}`);
        debug.log(`     chromaFormat: ${this.HEVCDecoderConfigurationRecord.chromaFormat}`);
        debug.log(`     bitDepthLumaMinus8: ${this.HEVCDecoderConfigurationRecord.bitDepthLumaMinus8}`);
        debug.log(`     bitDepthChromaMinus8: ${this.HEVCDecoderConfigurationRecord.bitDepthChromaMinus8}`);
        debug.log('  ');
        debug.log('-------------------------------------');
        debug.log('  ');
        debug.log(`Frame width: ${this.track.width}`);
        debug.log(`Frame height: ${this.track.height}`);
        debug.log(`Codec: ${this.track.codec}`);
    }
    
    parseNAL(unit) {
        if (!unit) 
            return false;

        let push = false;
        switch (unit.ntype) {
            case H265NALU.VPS:
                if (!this.track.vps) {
                    this.parseVPS(unit.getPayload());
                    if (!this.remuxer.readyToDecode && this.track.pps && this.track.sps && this.track.vps) {
                        this.remuxer.readyToDecode = true;
                    }
                }
                push = true;
                break;

            case H265NALU.SPS:
                if (!this.track.sps) {
                    if (this.parseSPS(unit.getPayload())) {
                        if (!this.remuxer.readyToDecode && this.track.pps && this.track.sps && this.track.vps) {
                            this.remuxer.readyToDecode = true;
                        }
                    }
                }
                push = true;
                break;

            case H265NALU.PPS:
                if (!this.track.pps) {
                    this.parsePPS(unit.getPayload());
                    if (!this.remuxer.readyToDecode && this.track.pps && this.track.sps && this.track.vps) {
                        this.remuxer.readyToDecode = true;
                    }
                }
                push = true;
                break;

            case H265NALU.AUD:
                debug.log('H265AUD - ignoring');
                break;

            case H265NALU.SEI_PREFIX:
            case H265NALU.SEI_SUFFIX:
                debug.log('H265SEI - ignoring');
                break;

            default:
                if (unit.isvcl) {
                    push = true;
                } else {
                    debug.log(`H265NALU: non VCL NALU type ${unit.ntype} - ignoring`);
                }
                break;
        }

        if (this.remuxer.readyToDecode && !this.track.dumped) {
            this.dumpTrack();
            this.track.dumped = true;
        }

        return push;
    }
}
